import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";
import app from "../server.js";

const secret = "export-route-test-secret";
const previousSecret = process.env.JWT_SECRET;
const userIds: string[] = [];
const documentIds: string[] = [];
const tagIds: string[] = [];
const base = "/api/v1/export";

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, 'test-hash', 'Export Test User') RETURNING id`,
    [`export-${randomUUID()}@example.com`],
  );
  const id = result.rows[0]!.id;
  userIds.push(id);
  return id;
}

async function document(ownerId: string, title: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id",
    [title, ownerId],
  );
  const id = result.rows[0]!.id;
  documentIds.push(id);
  await pool.query(
    "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'owner')",
    [id, ownerId],
  );
  return id;
}

async function version(
  documentId: string,
  uploaderId: string,
): Promise<string> {
  const id = randomUUID();
  const contents = Buffer.from(`version-${id}`);
  await pool.query(
    `INSERT INTO document_versions
       (id, document_id, number, filename, content_type, size, checksum,
        object_key, uploaded_by)
     VALUES ($1, $2, 1, 'notes.txt', 'text/plain', $3, $4, $5, $6)`,
    [
      id,
      documentId,
      contents.length,
      createHash("sha256").update(contents).digest("hex"),
      `documents/${documentId}/${id}`,
      uploaderId,
    ],
  );
  await pool.query(
    "UPDATE documents SET current_version_id = $2 WHERE id = $1",
    [documentId, id],
  );
  return id;
}

async function addTag(documentId: string, name: string): Promise<void> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO tags (name) VALUES ($1) RETURNING id",
    [name],
  );
  const id = result.rows[0]!.id;
  tagIds.push(id);
  await pool.query(
    "INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2)",
    [documentId, id],
  );
}

function bearer(userId: string): string {
  return `Bearer ${jwt.sign({}, secret, { subject: userId, expiresIn: "1h" })}`;
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

afterAll(async () => {
  try {
    if (documentIds.length) {
      await pool.query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [
        documentIds,
      ]);
    }
    if (tagIds.length) {
      await pool.query("DELETE FROM tags WHERE id = ANY($1::uuid[])", [tagIds]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
        userIds,
      ]);
    }
  } finally {
    await pool.end();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

describe("GET /api/v1/export", () => {
  it("downloads JSON metadata for documents owned by the caller and their versions", async () => {
    const caller = await user();
    const otherOwner = await user();
    const ownedId = await document(caller, "Owned document");
    const versionId = await version(ownedId, caller);
    const sharedId = await document(otherOwner, "Shared document");
    await version(sharedId, otherOwner);
    await pool.query(
      "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer')",
      [sharedId, caller],
    );
    const tagName = `project-${randomUUID()}`;
    await addTag(ownedId, tagName);

    const res = await request(app)
      .get(base)
      .query({ format: "json" })
      .set("Authorization", bearer(caller));

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-disposition"]).toContain(
      "contentcollab-export.json",
    );
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ownedId,
          ownerId: caller,
          tags: [tagName],
        }),
      ]),
    );
    expect(res.body.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: versionId,
          documentId: ownedId,
          number: 1,
        }),
      ]),
    );
    expect(res.body.documents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sharedId })]),
    );
    expect(res.body.versions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: sharedId }),
      ]),
    );
  });

  it("downloads CSV with a header and escapes a title containing a comma and quote", async () => {
    const caller = await user();
    const title = 'Budget, "draft"';
    const documentId = await document(caller, title);
    const versionId = await version(documentId, caller);

    const res = await request(app)
      .get(base)
      .query({ format: "csv" })
      .set("Authorization", bearer(caller));

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-disposition"]).toContain(
      "contentcollab-export.csv",
    );
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain('"documentId","title","ownerId"');
    expect(res.text).toContain(`"${documentId}","Budget, ""draft"""`);
    expect(res.text).toContain(`"${versionId}"`);
  });

  it("returns 400 VALIDATION with format details for a missing or invalid format", async () => {
    const caller = await user();

    for (const path of [base, `${base}?format=xml`]) {
      const res = await request(app)
        .get(path)
        .set("Authorization", bearer(caller));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
      expect(res.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "format" })]),
      );
    }
  });

  it("returns 401 UNAUTHORIZED without a token", async () => {
    const res = await request(app).get(`${base}?format=json`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});
