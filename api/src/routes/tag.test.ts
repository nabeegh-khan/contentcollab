import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";
import app from "../server.js";

const secret = "tags-route-test-secret";
const previousSecret = process.env.JWT_SECRET;
const userIds: string[] = [];
const documentIds: string[] = [];
const tagIds: string[] = [];
const base = "/api/v1/tags";

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, 'test-hash', 'Tags Test User') RETURNING id`,
    [`tags-${randomUUID()}@example.com`],
  );
  const id = result.rows[0]!.id;
  userIds.push(id);
  return id;
}

async function document(ownerId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO documents (title, owner_id) VALUES ('Tags Fixture', $1) RETURNING id",
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

async function tag(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO tags (name) VALUES ($1) RETURNING id",
    [name],
  );
  const id = result.rows[0]!.id;
  tagIds.push(id);
  return id;
}

async function attachTag(documentId: string, tagId: string): Promise<void> {
  await pool.query("INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2)", [
    documentId,
    tagId,
  ]);
}

function bearer(userId: string): string {
  return `Bearer ${jwt.sign({}, secret, { subject: userId, expiresIn: "1h" })}`;
}

beforeAll(async () => {
  process.env.JWT_SECRET = secret;
  await requireServices(
    [{ name: "PostgreSQL", host: process.env.DB_HOST ?? "localhost", port: Number(process.env.DB_PORT ?? 5432) }],
    1000,
  );
  await requireDatabase(pool, 1000);
});

afterAll(async () => {
  try {
    if (documentIds.length) {
      await pool.query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [documentIds]);
    }
    if (tagIds.length) {
      await pool.query("DELETE FROM tags WHERE id = ANY($1::uuid[])", [tagIds]);
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

describe("GET /api/v1/tags", () => {
  it("counts tags only on documents the caller can currently read", async () => {
    const caller = await user();
    const otherOwner = await user();
    const owned = await document(caller);
    const shared = await document(otherOwner);
    const privateDocument = await document(otherOwner);
    const expired = await document(otherOwner);

    await pool.query(
      "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer')",
      [shared, caller],
    );
    await pool.query(
      `INSERT INTO shares (document_id, user_id, role, expires_at)
       VALUES ($1, $2, 'viewer', NOW() - INTERVAL '1 minute')`,
      [expired, caller],
    );

    const commonName = `common-${randomUUID()}`;
    const ownedName = `owned-${randomUUID()}`;
    const hiddenName = `hidden-${randomUUID()}`;
    const common = await tag(commonName);
    const ownedOnly = await tag(ownedName);
    const hiddenOnly = await tag(hiddenName);

    for (const id of [owned, shared, privateDocument, expired]) {
      await attachTag(id, common);
    }
    await attachTag(owned, ownedOnly);
    await attachTag(privateDocument, hiddenOnly);
    await attachTag(expired, hiddenOnly);

    const res = await request(app).get(base).set("Authorization", bearer(caller));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true); // /tags is a bare array, not a page.
    expect(res.body).toEqual(
      expect.arrayContaining([
        { name: commonName, count: 2 },
        { name: ownedName, count: 1 },
      ]),
    );
    expect(res.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: hiddenName })]),
    );
  });

  it("returns an empty array when the caller has no readable documents", async () => {
    const caller = await user();
    const res = await request(app).get(base).set("Authorization", bearer(caller));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 401 UNAUTHORIZED without a token", async () => {
    const res = await request(app).get(base);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});
