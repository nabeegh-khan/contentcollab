import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";
import { requireAuth } from "./requireAuth.js";
import { requireRole } from "./requireRole.js";

const testSecret = "role-test-secret-that-is-not-used-outside-tests";
const previousSecret = process.env.JWT_SECRET;
const userIds: string[] = [];
const documentIds: string[] = [];
const app = express();

app.get(
  "/documents/:documentId/owner-only",
  requireAuth,
  requireRole("owner"),
  (_req, res) => res.status(200).json({ role: res.locals.documentShareRole }),
);

async function createUser(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`role-${crypto.randomUUID()}@example.com`, "test-only-hash", "Role Test User"],
  );
  const id = result.rows[0]!.id;
  userIds.push(id);
  return id;
}

async function createDocument(ownerId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id",
    ["Role Test Document", ownerId],
  );
  const id = result.rows[0]!.id;
  documentIds.push(id);
  return id;
}

function token(userId: string): string {
  return jwt.sign({}, testSecret, { subject: userId, expiresIn: "24h" });
}

beforeAll(async () => {
  process.env.JWT_SECRET = testSecret;
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
  if (documentIds.length > 0) {
    await pool.query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [documentIds]);
  }
  if (userIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  }
  await pool.end();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

describe("requireRole on an owner-only document route", () => {
  it("returns 404 when the caller has no share", async () => {
    const ownerId = await createUser();
    const callerId = await createUser();
    const documentId = await createDocument(ownerId);

    const res = await request(app)
      .get(`/documents/${documentId}/owner-only`)
      .set("Authorization", `Bearer ${token(callerId)}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 403 when a viewer calls an owner-only route", async () => {
    const ownerId = await createUser();
    const viewerId = await createUser();
    const documentId = await createDocument(ownerId);
    await pool.query(
      "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer')",
      [documentId, viewerId],
    );

    const res = await request(app)
      .get(`/documents/${documentId}/owner-only`)
      .set("Authorization", `Bearer ${token(viewerId)}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("lets an owner through with 200", async () => {
    const ownerId = await createUser();
    const documentId = await createDocument(ownerId);
    await pool.query(
      "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'owner')",
      [documentId, ownerId],
    );

    const res = await request(app)
      .get(`/documents/${documentId}/owner-only`)
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ role: "owner" });
  });
});
