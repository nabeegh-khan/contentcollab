import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";

const objects = new Map<string, Buffer>();
const putStream = jest.fn<
  (key: string, stream: Readable, contentType: string, signal: AbortSignal) => Promise<void>
>(async (key, stream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  objects.set(key, Buffer.concat(chunks));
});
const remove = jest.fn<(key: string) => Promise<void>>(async (key) => {
  objects.delete(key);
});
const getStream = jest.fn<(key: string) => Promise<Readable>>(async (key) => {
  const bytes = objects.get(key);
  if (!bytes) throw new Error("Missing test object");
  return Readable.from([bytes]);
});
const copy = jest.fn<(from: string, to: string) => Promise<void>>(async (from, to) => {
  const bytes = objects.get(from);
  if (!bytes) throw new Error("Missing test object");
  objects.set(to, bytes);
});

jest.unstable_mockModule("../lib/storage.js", () => ({ putStream, remove, getStream, copy }));
const { default: app } = await import("../server.js");

const secret = "versions-route-test-secret";
const previousSecret = process.env.JWT_SECRET;
const userIds: string[] = [];
const documentIds: string[] = [];
const root = "/api/v1/documents";

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, 'test-hash', 'Version Test User') RETURNING id`,
    [`version-${randomUUID()}@example.com`],
  );
  const id = result.rows[0]!.id;
  userIds.push(id);
  return id;
}

function bearer(userId: string): string {
  return `Bearer ${jwt.sign({}, secret, { subject: userId, expiresIn: "1h" })}`;
}

async function document(ownerId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO documents (title, owner_id) VALUES ('Version Fixture', $1) RETURNING id",
    [ownerId],
  );
  const id = result.rows[0]!.id;
  documentIds.push(id);
  await pool.query("INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'owner')", [
    id,
    ownerId,
  ]);
  return id;
}

async function share(documentId: string, userId: string, role: string): Promise<void> {
  await pool.query("INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, $3)", [
    documentId,
    userId,
    role,
  ]);
}

async function version(
  documentId: string,
  userId: string,
  number: number,
  bytes: Buffer,
  filename = "fixture.txt",
): Promise<{ id: string; key: string; checksum: string }> {
  const id = randomUUID();
  const key = `documents/${documentId}/${id}`;
  const checksum = createHash("sha256").update(bytes).digest("hex");
  objects.set(key, bytes);
  await pool.query(
    `INSERT INTO document_versions
       (id, document_id, number, filename, content_type, size, checksum,
        object_key, uploaded_by)
     VALUES ($1, $2, $3, $4, 'text/plain', $5, $6, $7, $8)`,
    [id, documentId, number, filename, bytes.length, checksum, key, userId],
  );
  await pool.query("UPDATE documents SET current_version_id = $2 WHERE id = $1", [documentId, id]);
  return { id, key, checksum };
}

beforeAll(async () => {
  process.env.JWT_SECRET = secret;
  await requireServices(
    [
      {
        name: "PostgreSQL",
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 5432),
      },
    ],
    1000,
  );
  await requireDatabase(pool, 1000);
});

afterEach(() => {
  putStream.mockClear();
  remove.mockClear();
  getStream.mockClear();
  copy.mockClear();
  objects.clear();
});

afterAll(async () => {
  try {
    if (documentIds.length) {
      await pool.query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [documentIds]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    }
  } finally {
    await pool.end();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

describe("GET /documents/:documentId/versions", () => {
  it("lists versions oldest first and pages by version number", async () => {
    const owner = await user();
    const viewer = await user();
    const id = await document(owner);
    await share(id, viewer, "viewer");
    const first = await version(id, owner, 1, Buffer.from("one"));
    const second = await version(id, owner, 2, Buffer.from("two"));

    const page1 = await request(app)
      .get(`${root}/${id}/versions?limit=1`)
      .set("Authorization", bearer(viewer));
    expect(page1.status).toBe(200);
    expect(page1.body.items).toEqual([expect.objectContaining({ id: first.id, number: 1 })]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await request(app)
      .get(`${root}/${id}/versions`)
      .query({ limit: 1, cursor: page1.body.nextCursor })
      .set("Authorization", bearer(viewer));
    expect(page2.status).toBe(200);
    expect(page2.body.items).toEqual([expect.objectContaining({ id: second.id, number: 2 })]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("returns 400 VALIDATION for invalid limit and cursor", async () => {
    const owner = await user();
    const id = await document(owner);
    for (const query of ["limit=0", "cursor=invalid"]) {
      const res = await request(app)
        .get(`${root}/${id}/versions?${query}`)
        .set("Authorization", bearer(owner));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
    }
  });

  it("returns 404 NOT_FOUND without a document share", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await document(owner);
    const res = await request(app)
      .get(`${root}/${id}/versions`)
      .set("Authorization", bearer(stranger));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("POST /documents/:documentId/versions", () => {
  it("uploads version 2, stores checksum, and makes it current", async () => {
    const owner = await user();
    const id = await document(owner);
    await version(id, owner, 1, Buffer.from("original"));
    const bytes = Buffer.from("changed contents");
    const res = await request(app)
      .post(`${root}/${id}/versions`)
      .set("Authorization", bearer(owner))
      .attach("file", bytes, { filename: "second.txt", contentType: "text/plain" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({ documentId: id, number: 2, filename: "second.txt" }),
    );
    expect(res.body.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
    const current = await pool.query<{ current_version_id: string }>(
      "SELECT current_version_id FROM documents WHERE id = $1",
      [id],
    );
    expect(current.rows[0]?.current_version_id).toBe(res.body.id);
  });

  it("returns 409 CONFLICT for the same checksum on the same document", async () => {
    const owner = await user();
    const id = await document(owner);
    const bytes = Buffer.from("duplicate contents");
    await version(id, owner, 1, bytes);
    const res = await request(app)
      .post(`${root}/${id}/versions`)
      .set("Authorization", bearer(owner))
      .attach("file", bytes, { filename: "again.txt", contentType: "text/plain" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
    expect(remove).toHaveBeenCalledTimes(1);
    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM document_versions WHERE document_id = $1",
      [id],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("returns 400 VALIDATION for a disallowed type or title field", async () => {
    const owner = await user();
    const id = await document(owner);
    const wrongType = await request(app)
      .post(`${root}/${id}/versions`)
      .set("Authorization", bearer(owner))
      .attach("file", Buffer.from("x"), {
        filename: "bad.exe",
        contentType: "application/octet-stream",
      });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.code).toBe("VALIDATION");

    const extraField = await request(app)
      .post(`${root}/${id}/versions`)
      .set("Authorization", bearer(owner))
      .field("title", "Not allowed")
      .attach("file", Buffer.from("x"), { filename: "valid.txt", contentType: "text/plain" });
    expect(extraField.status).toBe(400);
    expect(extraField.body.code).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION when no file is sent", async () => {
    const owner = await user();
    const id = await document(owner);
    const res = await request(app)
      .post(`${root}/${id}/versions`)
      .set("Authorization", bearer(owner))
      .field("title", "No file");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION for malformed multipart data", async () => {
    const owner = await user();
    const id = await document(owner);
    const boundary = `test-${randomUUID()}`;
    const malformed = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="broken.txt"\r\n' +
        "Content-Type: text/plain\r\n\r\n" +
        "incomplete file without a closing boundary",
    );
    const res = await request(app)
      .post(`${root}/${id}/versions`)
      .set("Authorization", bearer(owner))
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(malformed);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 413 TOO_LARGE for a file over 50 MB", async () => {
    const owner = await user();
    const id = await document(owner);
    const res = await request(app)
      .post(`${root}/${id}/versions`)
      .set("Authorization", bearer(owner))
      .attach("file", Buffer.alloc(50 * 1024 * 1024 + 1), {
        filename: "huge.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("TOO_LARGE");
  });

  it("returns 403 FORBIDDEN when a viewer uploads", async () => {
    const owner = await user();
    const viewer = await user();
    const id = await document(owner);
    await share(id, viewer, "viewer");
    const res = await request(app)
      .post(`${root}/${id}/versions`)
      .set("Authorization", bearer(viewer))
      .attach("file", Buffer.from("x"), "file.txt");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(putStream).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND without a document share", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await document(owner);
    const res = await request(app)
      .post(`${root}/${id}/versions`)
      .set("Authorization", bearer(stranger))
      .attach("file", Buffer.from("x"), "file.txt");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("GET /documents/:documentId/versions/:versionId", () => {
  it("returns metadata for a version belonging to the document", async () => {
    const owner = await user();
    const id = await document(owner);
    const item = await version(id, owner, 1, Buffer.from("contents"));
    const res = await request(app)
      .get(`${root}/${id}/versions/${item.id}`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: item.id, documentId: id, number: 1 }));
    expect(res.body).not.toHaveProperty("objectKey");
  });

  it("returns 400 VALIDATION for an invalid version ID", async () => {
    const owner = await user();
    const id = await document(owner);
    const res = await request(app)
      .get(`${root}/${id}/versions/not-a-uuid`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 404 NOT_FOUND for a version in another document", async () => {
    const owner = await user();
    const first = await document(owner);
    const second = await document(owner);
    const foreign = await version(first, owner, 1, Buffer.from("foreign"));
    const res = await request(app)
      .get(`${root}/${second}/versions/${foreign.id}`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("GET /documents/:documentId/versions/:versionId/content", () => {
  it("streams the file with content type and attachment filename", async () => {
    const owner = await user();
    const id = await document(owner);
    const bytes = Buffer.from("download me");
    const item = await version(id, owner, 1, bytes, "download.txt");
    const res = await request(app)
      .get(`${root}/${id}/versions/${item.id}/content`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.headers["content-disposition"]).toContain('attachment; filename="download.txt"');
    expect(res.headers["content-length"]).toBe(String(bytes.length));
    expect(res.text).toBe(bytes.toString());
    expect(getStream).toHaveBeenCalledWith(item.key);
  });

  it("returns 404 NOT_FOUND for a missing version", async () => {
    const owner = await user();
    const id = await document(owner);
    const res = await request(app)
      .get(`${root}/${id}/versions/${randomUUID()}/content`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 400 VALIDATION for an invalid version ID", async () => {
    const owner = await user();
    const id = await document(owner);
    const res = await request(app)
      .get(`${root}/${id}/versions/not-a-uuid/content`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 500 INTERNAL if object storage cannot provide the file", async () => {
    const owner = await user();
    const id = await document(owner);
    const item = await version(id, owner, 1, Buffer.from("contents"));
    getStream.mockRejectedValueOnce(new Error("Test storage failure"));
    const res = await request(app)
      .get(`${root}/${id}/versions/${item.id}/content`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL");
  });
});

describe("POST /documents/:documentId/versions/:versionId/revert", () => {
  it("creates a new version even when the source is already current", async () => {
    const owner = await user();
    const id = await document(owner);
    const source = await version(id, owner, 1, Buffer.from("original"));
    const res = await request(app)
      .post(`${root}/${id}/versions/${source.id}/revert`)
      .set("Authorization", bearer(owner));

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({ documentId: id, number: 2, checksum: source.checksum }),
    );
    expect(res.body.id).not.toBe(source.id);
    const inserted = await pool.query<{ object_key: string; reverted_from: string }>(
      "SELECT object_key, reverted_from FROM document_versions WHERE id = $1",
      [res.body.id],
    );
    expect(inserted.rows[0]).toEqual({ object_key: source.key, reverted_from: source.id });
    expect(copy).not.toHaveBeenCalled();
    const current = await pool.query<{ current_version_id: string }>(
      "SELECT current_version_id FROM documents WHERE id = $1",
      [id],
    );
    expect(current.rows[0]?.current_version_id).toBe(res.body.id);
  });

  it("returns 404 NOT_FOUND for a source version in another document", async () => {
    const owner = await user();
    const first = await document(owner);
    const second = await document(owner);
    const foreign = await version(first, owner, 1, Buffer.from("foreign"));
    const res = await request(app)
      .post(`${root}/${second}/versions/${foreign.id}/revert`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 403 FORBIDDEN for a viewer", async () => {
    const owner = await user();
    const viewer = await user();
    const id = await document(owner);
    await share(id, viewer, "viewer");
    const source = await version(id, owner, 1, Buffer.from("original"));
    const res = await request(app)
      .post(`${root}/${id}/versions/${source.id}/revert`)
      .set("Authorization", bearer(viewer));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("returns 400 VALIDATION for an invalid version ID", async () => {
    const owner = await user();
    const id = await document(owner);
    const res = await request(app)
      .post(`${root}/${id}/versions/not-a-uuid/revert`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });
});

describe("authentication on version routes", () => {
  it("returns 401 UNAUTHORIZED on each protected version route", async () => {
    const documentId = randomUUID();
    const versionId = randomUUID();
    const base = `${root}/${documentId}/versions`;
    const responses = await Promise.all([
      request(app).get(base),
      request(app).post(base).attach("file", Buffer.from("x"), "file.txt"),
      request(app).get(`${base}/${versionId}`),
      request(app).get(`${base}/${versionId}/content`),
      request(app).post(`${base}/${versionId}/revert`),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    }
  });
});
