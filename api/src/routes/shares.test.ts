import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import app from "../server.js";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";

// Place this file at api/src/routes/shares.test.ts before running it.
const secret = "shares-test-secret-not-used-outside-tests";
const previousSecret = process.env.JWT_SECRET;
const createdUserIds: string[] = [];
const createdDocumentIds: string[] = [];

async function createUser(): Promise<{ id: string; email: string }> {
  const email = `shares-${randomUUID()}@example.com`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [email, "test-only-hash", "Shares Test User"],
  );
  const id = result.rows[0]!.id;
  createdUserIds.push(id);
  return { id, email };
}

async function createDocument(ownerId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id",
    ["Shares Test Document", ownerId],
  );
  const id = result.rows[0]!.id;
  createdDocumentIds.push(id);
  await pool.query(
    "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'owner')",
    [id, ownerId],
  );
  return id;
}

function bearer(userId: string): string {
  return `Bearer ${jwt.sign({}, secret, { subject: userId, expiresIn: "24h" })}`;
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
    if (createdDocumentIds.length > 0) {
      await pool.query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [createdDocumentIds]);
    }
    if (createdUserIds.length > 0) {
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]);
    }
  } finally {
    await pool.end();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

describe("document shares", () => {
  it("creates a share by email with 201", async () => {
    const owner = await createUser();
    const invitee = await createUser();
    const documentId = await createDocument(owner.id);

    const res = await request(app)
      .post(`/api/v1/documents/${documentId}/shares`)
      .set("Authorization", bearer(owner.id))
      .send({ email: invitee.email, role: "viewer" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        documentId,
        userId: invitee.id,
        role: "viewer",
      }),
    );
  });

  it("returns 404 for an unknown email", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);

    const res = await request(app)
      .post(`/api/v1/documents/${documentId}/shares`)
      .set("Authorization", bearer(owner.id))
      .send({ email: `missing-${randomUUID()}@example.com`, role: "viewer" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 409 when that user is already shared on the document", async () => {
    const owner = await createUser();
    const invitee = await createUser();
    const documentId = await createDocument(owner.id);
    await pool.query(
      "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer')",
      [documentId, invitee.id],
    );

    const res = await request(app)
      .post(`/api/v1/documents/${documentId}/shares`)
      .set("Authorization", bearer(owner.id))
      .send({ email: invitee.email, role: "viewer" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("returns 403 when a non-owner tries to create a share", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const invitee = await createUser();
    const documentId = await createDocument(owner.id);
    await pool.query(
      "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer')",
      [documentId, viewer.id],
    );

    const res = await request(app)
      .post(`/api/v1/documents/${documentId}/shares`)
      .set("Authorization", bearer(viewer.id))
      .send({ email: invitee.email, role: "viewer" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("returns 404 for an expired link", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const token = randomUUID();
    await pool.query(
      `INSERT INTO shares (document_id, link_token, role, expires_at)
       VALUES ($1, $2, 'viewer', NOW() - INTERVAL '1 minute')`,
      [documentId, token],
    );

    const res = await request(app).get(`/api/v1/links/${token}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 200 with document and version for a valid link", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const token = randomUUID();
    await pool.query(
      `INSERT INTO shares (document_id, link_token, role, expires_at)
       VALUES ($1, $2, 'viewer', NOW() + INTERVAL '1 hour')`,
      [documentId, token],
    );

    // Public link read: no Authorization header. This fixture has no current version.
    const res = await request(app).get(`/api/v1/links/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.document).toEqual(
      expect.objectContaining({ id: documentId, role: "viewer", tags: [] }),
    );
    expect(res.body.version).toBeNull();
  });
});
