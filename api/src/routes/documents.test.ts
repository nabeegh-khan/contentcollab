import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";

// ESM mocks must be installed before importing server.ts and its routes.
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

class StorageNotFoundError extends Error {
  readonly statusCode = 404;
}
jest.unstable_mockModule("../lib/storage.js", () => ({
  putStream,
  remove,
  getStream,
  copy,
  validateStorageConfig: jest.fn(),
  StorageNotFoundError,
}));
const { default: app } = await import("../server.js");

const secret = "documents-route-test-secret";
const previousSecret = process.env.JWT_SECRET;
const userIds: string[] = [];
const documentIds: string[] = [];
const base = "/api/v1/documents";

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, 'test-hash', 'Document Test User') RETURNING id`,
    [`doc-${randomUUID()}@example.com`],
  );
  const id = result.rows[0]!.id;
  userIds.push(id);
  return id;
}

function bearer(userId: string): string {
  return `Bearer ${jwt.sign({}, secret, { subject: userId, expiresIn: "1h" })}`;
}

async function document(ownerId: string, title = "Test Document"): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id",
    [title, ownerId],
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

async function version(documentId: string, userId: string, bytes: Buffer): Promise<string> {
  const id = randomUUID();
  const key = `documents/${documentId}/${id}`;
  objects.set(key, bytes);
  await pool.query(
    `INSERT INTO document_versions
       (id, document_id, number, filename, content_type, size, checksum,
        object_key, uploaded_by)
     VALUES ($1, $2, 1, 'fixture.txt', 'text/plain', $3, $4, $5, $6)`,
    [id, documentId, bytes.length, createHash("sha256").update(bytes).digest("hex"), key, userId],
  );
  await pool.query("UPDATE documents SET current_version_id = $2 WHERE id = $1", [documentId, id]);
  return id;
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

describe("GET /api/v1/documents", () => {
  it("returns only readable documents and supports title and tag filters", async () => {
    const owner = await user();
    const reader = await user();
    const visible = await document(owner, "Budget Plan");
    await share(visible, reader, "viewer");
    await document(owner, "Private Plan");
    const tag = `finance-${randomUUID()}`;
    await pool.query("INSERT INTO tags (name) VALUES ($1)", [tag]);
    await pool.query(
      `INSERT INTO document_tags (document_id, tag_id)
       SELECT $1, id FROM tags WHERE name = $2`,
      [visible, tag],
    );

    const res = await request(app)
      .get(base)
      .query({ q: "budget", tag: tag.toUpperCase() })
      .set("Authorization", bearer(reader));

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({ id: visible, role: "viewer", tags: [tag] }),
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("paginates without repeating documents", async () => {
    const owner = await user();
    const ids = [await document(owner), await document(owner), await document(owner)];
    const first = await request(app).get(`${base}?limit=2`).set("Authorization", bearer(owner));
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get(base)
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set("Authorization", bearer(owner));
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(
      new Set([...first.body.items, ...second.body.items].map((d: { id: string }) => d.id)),
    ).toEqual(new Set(ids));
    expect(second.body.nextCursor).toBeNull();
  });

  it("returns 400 VALIDATION for invalid list queries", async () => {
    const owner = await user();
    for (const query of ["limit=101", "cursor=invalid", "limit=1&limit=2"]) {
      const res = await request(app).get(`${base}?${query}`).set("Authorization", bearer(owner));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
      expect(res.body.details).toEqual(expect.any(Array));
    }
  });

  it("returns 401 UNAUTHORIZED without a token", async () => {
    const res = await request(app).get(base);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /api/v1/documents", () => {
  it("allows identical contents in two different documents", async () => {
    const owner = await user();
    const bytes = Buffer.from("same bytes in different documents");
    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post(base)
        .set("Authorization", bearer(owner))
        .attach("file", bytes, { filename: "same.txt", contentType: "text/plain" });
      expect(res.status).toBe(201);
      documentIds.push(res.body.id);
    }
  });

  it("creates a document and version 1 with the streamed checksum", async () => {
    const owner = await user();
    const bytes = Buffer.from("new document contents");
    const res = await request(app)
      .post(base)
      .set("Authorization", bearer(owner))
      .field("title", "My Document")
      .attach("file", bytes, { filename: "file.txt", contentType: "text/plain" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({ title: "My Document", role: "owner", tags: [] }),
    );
    documentIds.push(res.body.id);
    const stored = await pool.query<{
      number: number;
      checksum: string;
      object_key: string;
      reverted_from: string | null;
    }>("SELECT number, checksum, object_key, reverted_from FROM document_versions WHERE id = $1", [
      res.body.currentVersionId,
    ]);
    expect(stored.rows[0]).toEqual(
      expect.objectContaining({
        number: 1,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        reverted_from: null,
      }),
    );
    expect(objects.get(stored.rows[0]!.object_key)).toEqual(bytes);
  });

  it("returns 400 VALIDATION for an extra field", async () => {
    const owner = await user();
    const res = await request(app)
      .post(base)
      .set("Authorization", bearer(owner))
      .field("title", "Valid title")
      .field("extra", "unexpected")
      .attach("file", Buffer.from("contents"), {
        filename: "file.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION for an extra file", async () => {
    const owner = await user();
    const res = await request(app)
      .post(base)
      .set("Authorization", bearer(owner))
      .attach("file", Buffer.from("first"), {
        filename: "first.txt",
        contentType: "text/plain",
      })
      .attach("file", Buffer.from("second"), {
        filename: "second.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION for a disallowed file type", async () => {
    const owner = await user();
    const res = await request(app)
      .post(base)
      .set("Authorization", bearer(owner))
      .attach("file", Buffer.from("x"), {
        filename: "file.exe",
        contentType: "application/octet-stream",
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
    expect(putStream).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION when the multipart body has no file", async () => {
    const owner = await user();
    const res = await request(app)
      .post(base)
      .set("Authorization", bearer(owner))
      .field("title", "No file");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 413 TOO_LARGE for a file over 50 MB", async () => {
    const owner = await user();
    const res = await request(app)
      .post(base)
      .set("Authorization", bearer(owner))
      .attach("file", Buffer.alloc(50 * 1024 * 1024 + 1), {
        filename: "huge.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("TOO_LARGE");
  });

  it("returns 401 UNAUTHORIZED without a token", async () => {
    const res = await request(app).post(base).attach("file", Buffer.from("x"), "file.txt");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("returns 500 INTERNAL when object storage fails", async () => {
    const owner = await user();
    putStream.mockImplementationOnce(async (_key, stream) => {
      stream.resume();
      throw new Error("Test storage failure");
    });
    const res = await request(app)
      .post(base)
      .set("Authorization", bearer(owner))
      .attach("file", Buffer.from("x"), { filename: "file.txt", contentType: "text/plain" });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL");
  });
});

describe("GET /api/v1/documents/:documentId", () => {
  it("returns the document, its tags, and the caller's role", async () => {
    const owner = await user();
    const viewer = await user();
    const id = await document(owner);
    await share(id, viewer, "viewer");
    const res = await request(app).get(`${base}/${id}`).set("Authorization", bearer(viewer));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ id, ownerId: owner, role: "viewer", tags: [] }),
    );
  });

  it("returns 404 NOT_FOUND when the caller has no share", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await document(owner);
    const res = await request(app).get(`${base}/${id}`).set("Authorization", bearer(stranger));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 400 VALIDATION for an invalid document ID", async () => {
    const caller = await user();
    const res = await request(app).get(`${base}/not-a-uuid`).set("Authorization", bearer(caller));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });
});

describe("PATCH /api/v1/documents/:documentId", () => {
  it("replaces tags and updates the title in one request", async () => {
    const owner = await user();
    const id = await document(owner);
    const res = await request(app)
      .patch(`${base}/${id}`)
      .set("Authorization", bearer(owner))
      .send({ title: "Renamed", tags: ["alpha", "BETA", "alpha"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id, title: "Renamed" }));
    expect(res.body.tags).toHaveLength(2);
    expect(res.body.tags).toEqual(expect.arrayContaining(["alpha", "BETA"]));

    const cleared = await request(app)
      .patch(`${base}/${id}`)
      .set("Authorization", bearer(owner))
      .send({ tags: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tags).toEqual([]);
  });

  it("returns 400 VALIDATION for an unknown field", async () => {
    const owner = await user();
    const id = await document(owner);
    const res = await request(app)
      .patch(`${base}/${id}`)
      .set("Authorization", bearer(owner))
      .send({ title: "Valid", unknown: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
    expect(res.body.details).toEqual(expect.any(Array));
  });

  it("returns 403 FORBIDDEN for a viewer", async () => {
    const owner = await user();
    const viewer = await user();
    const id = await document(owner);
    await share(id, viewer, "viewer");
    const res = await request(app)
      .patch(`${base}/${id}`)
      .set("Authorization", bearer(viewer))
      .send({ title: "Denied" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("returns 404 NOT_FOUND without a document share", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await document(owner);
    const res = await request(app)
      .patch(`${base}/${id}`)
      .set("Authorization", bearer(stranger))
      .send({ title: "Denied" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("DELETE /api/v1/documents/:documentId", () => {
  it("returns 204 and deletes each stored object once, even after a revert", async () => {
    const owner = await user();
    const id = await document(owner);
    const versionId = await version(id, owner, Buffer.from("original"));
    const key = `documents/${id}/${versionId}`;
    const revertedId = randomUUID();
    await pool.query(
      `INSERT INTO document_versions
         (id, document_id, number, filename, content_type, size, checksum,
          object_key, uploaded_by, reverted_from)
       SELECT $1, document_id, 2, filename, content_type, size, checksum,
              object_key, uploaded_by, id
       FROM document_versions WHERE id = $2`,
      [revertedId, versionId],
    );

    const res = await request(app).delete(`${base}/${id}`).set("Authorization", bearer(owner));
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(key);
    const remaining = await pool.query("SELECT id FROM documents WHERE id = $1", [id]);
    expect(remaining.rowCount).toBe(0);
  });

  it("returns 403 FORBIDDEN for an editor", async () => {
    const owner = await user();
    const editor = await user();
    const id = await document(owner);
    await share(id, editor, "editor");
    const res = await request(app).delete(`${base}/${id}`).set("Authorization", bearer(editor));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("returns 404 NOT_FOUND to a user without a share", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await document(owner);
    const res = await request(app).delete(`${base}/${id}`).set("Authorization", bearer(stranger));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("authentication on document routes", () => {
  it("returns 401 UNAUTHORIZED on each protected document route", async () => {
    const id = randomUUID();
    const responses = await Promise.all([
      request(app).get(base),
      request(app).post(base).attach("file", Buffer.from("x"), "file.txt"),
      request(app).get(`${base}/${id}`),
      request(app).patch(`${base}/${id}`).send({ title: "x" }),
      request(app).delete(`${base}/${id}`),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    }
  });
});
