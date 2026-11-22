import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import app from "../server.js";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";

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
  await pool.query("INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'owner')", [
    id,
    ownerId,
  ]);
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
  it("lists shares for an owner with 200", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const documentId = await createDocument(owner.id);
    await pool.query("INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      documentId,
      viewer.id,
    ]);

    const res = await request(app)
      .get(`/api/v1/documents/${documentId}/shares`)
      .set("Authorization", bearer(owner.id));

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId, userId: owner.id, role: "owner" }),
        expect.objectContaining({ documentId, userId: viewer.id, role: "viewer" }),
      ]),
    );
    expect(res.body.nextCursor).toBeNull();
  });

  it("returns 400 for an invalid share-list limit", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const res = await request(app)
      .get(`/api/v1/documents/${documentId}/shares?limit=101`)
      .set("Authorization", bearer(owner.id));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "limit" })]),
    );
  });

  it("returns 401 for each protected share route without a token", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const path = `/api/v1/documents/${documentId}/shares`;
    const sharePath = `${path}/${randomUUID()}`;
    const responses = await Promise.all([
      request(app).get(path),
      request(app).post(path).send({ link: true, role: "viewer" }),
      request(app).patch(sharePath).send({ role: "editor" }),
      request(app).delete(sharePath),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    }
  });

  it("creates a link share with 201", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const res = await request(app)
      .post(`/api/v1/documents/${documentId}/shares`)
      .set("Authorization", bearer(owner.id))
      .send({ link: true, role: "viewer", expiresAt });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        documentId,
        userId: null,
        role: "viewer",
        expiresAt,
        linkToken: expect.any(String),
      }),
    );
    const stored = await pool.query<{ link_token: string }>(
      "SELECT link_token FROM shares WHERE id = $1",
      [res.body.id],
    );
    expect(stored.rows[0]?.link_token).toBe(res.body.linkToken);
  });

  it("returns 400 when creating a share with an owner role or unknown field", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    for (const body of [
      { link: true, role: "owner" },
      { link: true, role: "viewer", unexpected: true },
    ]) {
      const res = await request(app)
        .post(`/api/v1/documents/${documentId}/shares`)
        .set("Authorization", bearer(owner.id))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
      expect(res.body.details).toEqual(expect.any(Array));
    }
  });

  it("updates a non-owner share with 200", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const documentId = await createDocument(owner.id);
    const share = await pool.query<{ id: string }>(
      "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer') RETURNING id",
      [documentId, viewer.id],
    );

    const res = await request(app)
      .patch(`/api/v1/documents/${documentId}/shares/${share.rows[0]!.id}`)
      .set("Authorization", bearer(owner.id))
      .send({ role: "editor" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: share.rows[0]!.id, role: "editor" }));
  });

  it("returns 400 for an empty share update", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const res = await request(app)
      .patch(`/api/v1/documents/${documentId}/shares/${randomUUID()}`)
      .set("Authorization", bearer(owner.id))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 404 when updating a missing share", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const res = await request(app)
      .patch(`/api/v1/documents/${documentId}/shares/${randomUUID()}`)
      .set("Authorization", bearer(owner.id))
      .send({ role: "editor" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 403 when updating the owner share", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const share = await pool.query<{ id: string }>(
      "SELECT id FROM shares WHERE document_id = $1 AND user_id = $2",
      [documentId, owner.id],
    );
    const res = await request(app)
      .patch(`/api/v1/documents/${documentId}/shares/${share.rows[0]!.id}`)
      .set("Authorization", bearer(owner.id))
      .send({ role: "viewer" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("deletes a non-owner share with 204", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const documentId = await createDocument(owner.id);
    const share = await pool.query<{ id: string }>(
      "INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer') RETURNING id",
      [documentId, viewer.id],
    );
    const shareId = share.rows[0]!.id;

    const res = await request(app)
      .delete(`/api/v1/documents/${documentId}/shares/${shareId}`)
      .set("Authorization", bearer(owner.id));

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    const remaining = await pool.query("SELECT id FROM shares WHERE id = $1", [shareId]);
    expect(remaining.rowCount).toBe(0);
  });

  it("returns 404 when deleting a missing share", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const res = await request(app)
      .delete(`/api/v1/documents/${documentId}/shares/${randomUUID()}`)
      .set("Authorization", bearer(owner.id));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 403 when deleting the caller's own owner share", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner.id);
    const share = await pool.query<{ id: string }>(
      "SELECT id FROM shares WHERE document_id = $1 AND user_id = $2",
      [documentId, owner.id],
    );
    const res = await request(app)
      .delete(`/api/v1/documents/${documentId}/shares/${share.rows[0]!.id}`)
      .set("Authorization", bearer(owner.id));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

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
    await pool.query("INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      documentId,
      invitee.id,
    ]);

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
    await pool.query("INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      documentId,
      viewer.id,
    ]);

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
