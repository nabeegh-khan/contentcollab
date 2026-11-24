// GET /api/v1/documents/:documentId/versions/compare (#23, ARCHITECTURE D33): sign-in, a role on the document,
// versions of this document only, text only. Real database, object store replaced as in versions.test.ts.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";
import { MAX_VERSION_BYTES } from "../lib/versionCompare.js";

const objects = new Map<string, Buffer>();
const getStream = jest.fn<(key: string) => Promise<Readable>>(async (key) => {
  const bytes = objects.get(key);
  if (!bytes) throw new Error("Missing test object");
  return Readable.from([bytes]);
});
class StorageNotFoundError extends Error {
  readonly statusCode = 404;
}
jest.unstable_mockModule("../lib/storage.js", () => ({
  putStream: jest.fn(),
  remove: jest.fn(),
  getStream,
  copy: jest.fn(),
  validateStorageConfig: jest.fn(),
  StorageNotFoundError,
}));
const { default: app } = await import("../server.js");

const signingKey = "compare-route-test-key";
const previousKey = process.env.JWT_SECRET;
const userIds: string[] = [];
const documentIds: string[] = [];
const root = "/api/v1/documents";

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, 'test-hash', 'Compare Test User') RETURNING id`,
    [`compare-${randomUUID()}@example.com`],
  );
  userIds.push(result.rows[0]!.id);
  return result.rows[0]!.id;
}

const bearer = (userId: string) =>
  `Bearer ${jwt.sign({}, signingKey, { subject: userId, expiresIn: "1h" })}`;

async function document(ownerId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO documents (title, owner_id) VALUES ('Compare Fixture', $1) RETURNING id",
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

async function version(
  documentId: string,
  userId: string,
  number: number,
  text: string,
  contentType = "text/plain",
): Promise<string> {
  const id = randomUUID();
  const key = `documents/${documentId}/${id}`;
  const bytes = Buffer.from(text);
  objects.set(key, bytes);
  await pool.query(
    `INSERT INTO document_versions
       (id, document_id, number, filename, content_type, size, checksum, object_key, uploaded_by)
     VALUES ($1, $2, $3, 'fixture.txt', $4, $5, $6, $7, $8)`,
    [
      id,
      documentId,
      number,
      contentType,
      bytes.length,
      randomUUID().replaceAll("-", ""),
      key,
      userId,
    ],
  );
  return id;
}

beforeAll(async () => {
  process.env.JWT_SECRET = signingKey;
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
  getStream.mockClear();
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
    if (previousKey === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousKey;
    await pool.end();
  }
});

const compare = (documentId: string, from: string, to: string, auth?: string) => {
  const req = request(app).get(`${root}/${documentId}/versions/compare?from=${from}&to=${to}`);
  return auth ? req.set("Authorization", auth) : req;
};

describe("GET /documents/:documentId/versions/compare", () => {
  it("returns the line diff for a viewer, and is not taken for a version id", async () => {
    const owner = await user();
    const viewer = await user();
    const doc = await document(owner);
    await pool.query("INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      doc,
      viewer,
    ]);
    const v1 = await version(doc, owner, 1, "a\nb\n");
    const v2 = await version(doc, owner, 2, "a\nc\n");
    const res = await compare(doc, v1, v2, bearer(viewer));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      from: { id: v1, number: 1 },
      to: { id: v2, number: 2 },
      added: 1,
      removed: 1,
    });
    expect(res.body.lines).toHaveLength(3);
  });

  it("is 401 without a token", async () => {
    const owner = await user();
    const doc = await document(owner);
    const v1 = await version(doc, owner, 1, "a");
    const v2 = await version(doc, owner, 2, "b");
    expect((await compare(doc, v1, v2)).status).toBe(401);
  });

  it("is 404 for a user with no share on the document, and reads no file", async () => {
    const owner = await user();
    const stranger = await user();
    const doc = await document(owner);
    const v1 = await version(doc, owner, 1, "a");
    const v2 = await version(doc, owner, 2, "b");
    const res = await compare(doc, v1, v2, bearer(stranger));
    expect(res.status).toBe(404);
    expect(getStream).not.toHaveBeenCalled();
  });

  it("is 404 when one version belongs to another document", async () => {
    const owner = await user();
    const doc = await document(owner);
    const other = await document(owner);
    const v1 = await version(doc, owner, 1, "a");
    const foreign = await version(other, owner, 1, "b");
    const res = await compare(doc, v1, foreign, bearer(owner));
    expect(res.status).toBe(404);
    expect(getStream).not.toHaveBeenCalled();
  });

  it("is 400 for ids that are not UUIDs or are equal", async () => {
    const owner = await user();
    const doc = await document(owner);
    const v1 = await version(doc, owner, 1, "a");
    expect((await compare(doc, "x", v1, bearer(owner))).status).toBe(400);
    const same = await compare(doc, v1, v1, bearer(owner));
    expect(same.status).toBe(400);
    expect(same.body.code).toBe("VALIDATION");
  });

  it("is 413 when a stored file is larger than its row says", async () => {
    const owner = await user();
    const doc = await document(owner);
    const v1 = await version(doc, owner, 1, "a");
    const v2 = await version(doc, owner, 2, "b");
    const key = (
      await pool.query<{ object_key: string }>(
        "SELECT object_key FROM document_versions WHERE id = $1",
        [v2],
      )
    ).rows[0]!.object_key;
    objects.set(key, Buffer.alloc(MAX_VERSION_BYTES + 1, "x"));
    const res = await compare(doc, v1, v2, bearer(owner));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("TOO_LARGE");
  });

  it("is 415 when a version is not text", async () => {
    const owner = await user();
    const doc = await document(owner);
    const v1 = await version(doc, owner, 1, "a");
    const v2 = await version(doc, owner, 2, "%PDF-", "application/pdf");
    const res = await compare(doc, v1, v2, bearer(owner));
    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_TYPE");
  });
});
