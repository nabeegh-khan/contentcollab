import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import app from "../server.js";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";

const base = "/api/v1/documents";
const testSecret = "comments-test-secret-that-is-not-used-outside-tests";
const previousSecret = process.env.JWT_SECRET;

const userIds: string[] = [];
const documentIds: string[] = [];

async function createUser(displayName = "Comment Test User"): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`comments-${crypto.randomUUID()}@example.com`, "test-only-hash", displayName],
  );
  const id = result.rows[0]!.id;
  userIds.push(id);
  return id;
}

async function createDocument(ownerId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id",
    ["Comments Test Document", ownerId],
  );
  const id = result.rows[0]!.id;
  documentIds.push(id);

  await pool.query("INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, 'owner')", [
    id,
    ownerId,
  ]);

  return id;
}

async function createVersion(documentId: string, uploadedBy: string, number = 1): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO document_versions (
       document_id, number, filename, content_type, size,
       checksum, object_key, uploaded_by
     )
    VALUES ($1, $2, 'test.txt', 'text/plain', 0, $3, $4, $5)   
    RETURNING id`,
    [documentId, number, crypto.randomUUID(), `test/${crypto.randomUUID()}`, uploadedBy],
  );
  return result.rows[0]!.id;
}

async function addShare(
  documentId: string,
  userId: string,
  role: "owner" | "editor" | "commenter" | "viewer",
): Promise<void> {
  await pool.query("INSERT INTO shares (document_id, user_id, role) VALUES ($1, $2, $3)", [
    documentId,
    userId,
    role,
  ]);
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

describe("comments API", () => {
  it("creates a comment with 201", async () => {
    const ownerId = await createUser("Owner");
    const commenterId = await createUser("Commenter");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, commenterId, "commenter");

    const res = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(commenterId)}`)
      .send({ body: "This is a test comment" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        versionId,
        authorId: commenterId,
        parentId: null,
        body: "This is a test comment",
        resolved: false,
      }),
    );
  });

  it("returns 403 when a viewer tries to create a comment", async () => {
    const ownerId = await createUser("Owner");
    const viewerId = await createUser("Viewer");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, viewerId, "viewer");

    const res = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(viewerId)}`)
      .send({ body: "A viewer cannot comment" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("returns 400 for an invalid anchor", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const res = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({
        body: "Invalid anchor",
        anchor: { page: 0, x: 1.5, y: -0.2 },
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 400 when replying to a comment on another version", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const version1 = await createVersion(documentId, ownerId, 1);
    const version2 = await createVersion(documentId, ownerId, 2);

    const parent = await request(app)
      .post(`${base}/${documentId}/versions/${version1}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Parent comment" });

    expect(parent.status).toBe(201);

    const reply = await request(app)
      .post(`${base}/${documentId}/versions/${version2}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({
        body: "Reply on another version",
        parentId: parent.body.id,
      });

    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("VALIDATION");
  });

  it("returns 403 when someone else tries to edit a comment", async () => {
    const ownerId = await createUser("Owner");
    const otherUserId = await createUser("Other User");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, otherUserId, "commenter");

    const comment = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Original comment" });

    expect(comment.status).toBe(201);

    const edit = await request(app)
      .patch(`${base}/${documentId}/comments/${comment.body.id}`)
      .set("Authorization", `Bearer ${token(otherUserId)}`)
      .send({ body: "Changed by someone else" });

    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe("FORBIDDEN");
  });

  it("creates mentions only for users with an active document share", async () => {
    const ownerId = await createUser("Owner");
    const sharedUserId = await createUser("SharedPerson");
    await createUser("UnsharedPerson");

    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, sharedUserId, "commenter");

    const comment = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({
        body: "Hello @SharedPerson and @UnsharedPerson",
      });

    expect(comment.status).toBe(201);

    const mentions = await pool.query<{ mentioned_user_id: string }>(
      "SELECT mentioned_user_id FROM comment_mentions WHERE comment_id = $1",
      [comment.body.id],
    );

    expect(mentions.rows).toEqual([{ mentioned_user_id: sharedUserId }]);
  });

  it("returns comments in oldest-first order and allows viewers to read", async () => {
    const ownerId = await createUser("Owner");
    const viewerId = await createUser("Viewer");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, viewerId, "viewer");

    const first = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "First comment" });

    const second = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Second comment" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const res = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(viewerId)}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((comment: { id: string }) => comment.id)).toEqual([
      first.body.id,
      second.body.id,
    ]);
  });

  it("paginates comments using limit and cursor", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const createdComments = [];

    for (const body of ["First", "Second", "Third"]) {
      const comment = await request(app)
        .post(`${base}/${documentId}/versions/${versionId}/comments`)
        .set("Authorization", `Bearer ${token(ownerId)}`)
        .send({ body });

      expect(comment.status).toBe(201);
      createdComments.push(comment.body);
    }

    const firstPage = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments`)
      .query({ limit: 2 })
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items.map((comment: { id: string }) => comment.id)).toEqual([
      createdComments[0].id,
      createdComments[1].id,
    ]);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments`)
      .query({ limit: 2, cursor: firstPage.body.nextCursor })
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items.map((comment: { id: string }) => comment.id)).toEqual([
      createdComments[2].id,
    ]);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it("returns 400 for an invalid pagination limit", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const res = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments?limit=101`)
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("filters comments by resolved status", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const openComment = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Open comment" });

    const resolvedComment = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Resolved comment" });

    expect(openComment.status).toBe(201);
    expect(resolvedComment.status).toBe(201);

    const update = await request(app)
      .patch(`${base}/${documentId}/comments/${resolvedComment.body.id}`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ resolved: true });

    expect(update.status).toBe(200);

    const openResults = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments?resolved=false`)
      .set("Authorization", `Bearer ${token(ownerId)}`);

    const resolvedResults = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments?resolved=true`)
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(openResults.status).toBe(200);
    expect(resolvedResults.status).toBe(200);
    expect(openResults.body.items.map((comment: { id: string }) => comment.id)).toContain(
      openComment.body.id,
    );
    expect(openResults.body.items.map((comment: { id: string }) => comment.id)).not.toContain(
      resolvedComment.body.id,
    );
    expect(resolvedResults.body.items.map((comment: { id: string }) => comment.id)).toContain(
      resolvedComment.body.id,
    );
  });

  it("returns 404 when the caller has no document share", async () => {
    const ownerId = await createUser("Owner");
    const otherUserId = await createUser("Other User");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const res = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(otherUserId)}`);

    expect(res.status).toBe(404);
  });

  it("returns 401 when the caller has no token", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const res = await request(app).get(`${base}/${documentId}/versions/${versionId}/comments`);

    expect(res.status).toBe(401);
  });

  it("returns 404 when a comment belongs to a different document than the path", async () => {
    const firstOwnerId = await createUser("First Owner");
    const secondOwnerId = await createUser("Second Owner");
    const commenterId = await createUser("Commenter");

    const firstDocumentId = await createDocument(firstOwnerId);
    const secondDocumentId = await createDocument(secondOwnerId);

    await addShare(firstDocumentId, commenterId, "commenter");

    const secondVersionId = await createVersion(secondDocumentId, secondOwnerId);

    const comment = await request(app)
      .post(`${base}/${secondDocumentId}/versions/${secondVersionId}/comments`)
      .set("Authorization", `Bearer ${token(secondOwnerId)}`)
      .send({ body: "Comment on another document" });

    expect(comment.status).toBe(201);

    const res = await request(app)
      .patch(`${base}/${firstDocumentId}/comments/${comment.body.id}`)
      .set("Authorization", `Bearer ${token(commenterId)}`)
      .send({ body: "Attempted edit" });

    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid resolved filter", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const res = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments?resolved=maybe`)
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("allows a comment author to edit their own comment", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const comment = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Original text" });

    const edit = await request(app)
      .patch(`${base}/${documentId}/comments/${comment.body.id}`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Updated text" });

    expect(edit.status).toBe(200);
    expect(edit.body.id).toBe(comment.body.id);
    expect(edit.body.body).toBe("Updated text");
  });

  it("allows the root author to resolve a thread through a reply", async () => {
    const ownerId = await createUser("Owner");
    const commenterId = await createUser("Commenter");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, commenterId, "commenter");

    const root = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Root comment" });

    const reply = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(commenterId)}`)
      .send({ body: "Reply", parentId: root.body.id });

    const resolve = await request(app)
      .patch(`${base}/${documentId}/comments/${reply.body.id}`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ resolved: true });

    expect(resolve.status).toBe(200);
    expect(resolve.body.id).toBe(root.body.id);
    expect(resolve.body.parentId).toBeNull();
    expect(resolve.body.resolved).toBe(true);
  });

  it("updates a reply body and resolves its root in one PATCH", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const root = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Root comment" });

    const reply = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Original reply", parentId: root.body.id });

    const update = await request(app)
      .patch(`${base}/${documentId}/comments/${reply.body.id}`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Edited reply", resolved: true });

    expect(update.status).toBe(200);
    expect(update.body.id).toBe(root.body.id);
    expect(update.body.parentId).toBeNull();
    expect(update.body.resolved).toBe(true);

    const comments = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(comments.status).toBe(200);

    const updatedReply = comments.body.items.find(
      (comment: { id: string; body: string }) => comment.id === reply.body.id,
    );

    expect(updatedReply).toBeDefined();
    expect(updatedReply.body).toBe("Edited reply");
  });

  it("prevents a reply author from resolving someone else's thread", async () => {
    const ownerId = await createUser("Owner");
    const commenterId = await createUser("Commenter");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, commenterId, "commenter");

    const root = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Root comment" });

    const reply = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(commenterId)}`)
      .send({ body: "Reply", parentId: root.body.id });

    const resolve = await request(app)
      .patch(`${base}/${documentId}/comments/${reply.body.id}`)
      .set("Authorization", `Bearer ${token(commenterId)}`)
      .send({ resolved: true });

    expect(resolve.status).toBe(403);
    expect(resolve.body.code).toBe("FORBIDDEN");
  });

  it("allows a comment author to delete their own comment", async () => {
    const ownerId = await createUser("Owner");
    const commenterId = await createUser("Commenter");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, commenterId, "commenter");

    const comment = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(commenterId)}`)
      .send({ body: "My comment" });

    const deletion = await request(app)
      .delete(`${base}/${documentId}/comments/${comment.body.id}`)
      .set("Authorization", `Bearer ${token(commenterId)}`);

    expect(deletion.status).toBe(204);
  });

  it("allows the document owner to delete another user's comment", async () => {
    const ownerId = await createUser("Owner");
    const commenterId = await createUser("Commenter");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, commenterId, "commenter");

    const comment = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(commenterId)}`)
      .send({ body: "Comment to delete" });

    const deletion = await request(app)
      .delete(`${base}/${documentId}/comments/${comment.body.id}`)
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(deletion.status).toBe(204);
  });

  it("prevents another commenter from deleting someone else's comment", async () => {
    const ownerId = await createUser("Owner");
    const firstCommenterId = await createUser("First Commenter");
    const secondCommenterId = await createUser("Second Commenter");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, firstCommenterId, "commenter");
    await addShare(documentId, secondCommenterId, "commenter");

    const comment = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(firstCommenterId)}`)
      .send({ body: "Protected comment" });

    const deletion = await request(app)
      .delete(`${base}/${documentId}/comments/${comment.body.id}`)
      .set("Authorization", `Bearer ${token(secondCommenterId)}`);

    expect(deletion.status).toBe(403);
    expect(deletion.body.code).toBe("FORBIDDEN");
  });

  it("uses the root thread's resolved status for nested replies", async () => {
    const ownerId = await createUser("Owner");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);

    const root = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Root comment" });

    const reply = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "First reply", parentId: root.body.id });

    const nestedReply = await request(app)
      .post(`${base}/${documentId}/versions/${versionId}/comments`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "Nested reply", parentId: reply.body.id });

    expect(root.status).toBe(201);
    expect(reply.status).toBe(201);
    expect(nestedReply.status).toBe(201);

    const resolve = await request(app)
      .patch(`${base}/${documentId}/comments/${root.body.id}`)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ resolved: true });

    expect(resolve.status).toBe(200);

    const res = await request(app)
      .get(`${base}/${documentId}/versions/${versionId}/comments?resolved=true`)
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((comment: { id: string }) => comment.id)).toEqual([
      root.body.id,
      reply.body.id,
      nestedReply.body.id,
    ]);
  });
});

describe("comment author display name (demo polish, 24 Nov)", () => {
  async function setup() {
    const ownerId = await createUser("Admin Owner");
    const reviewerId = await createUser("Reviewer Rita");
    const documentId = await createDocument(ownerId);
    const versionId = await createVersion(documentId, ownerId);
    await addShare(documentId, reviewerId, "commenter");
    const url = `${base}/${documentId}/versions/${versionId}/comments`;
    return { ownerId, reviewerId, documentId, url };
  }

  it("names the author in the created comment, which the live event also carries", async () => {
    const { reviewerId, url } = await setup();

    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${token(reviewerId)}`)
      .send({ body: "Approved" });

    expect(res.status).toBe(201);
    expect(res.body.authorDisplayName).toBe("Reviewer Rita");
    expect(res.body.authorId).toBe(reviewerId);
  });

  it("names every author in the list, for comments by two different people", async () => {
    const { ownerId, reviewerId, url } = await setup();
    await request(app)
      .post(url)
      .set("Authorization", `Bearer ${token(ownerId)}`)
      .send({ body: "From the owner" });
    await request(app)
      .post(url)
      .set("Authorization", `Bearer ${token(reviewerId)}`)
      .send({ body: "From the reviewer" });

    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${token(ownerId)}`);

    expect(res.status).toBe(200);
    expect(
      res.body.items.map((c: { body: string; authorDisplayName: string }) => [
        c.body,
        c.authorDisplayName,
      ]),
    ).toEqual([
      ["From the owner", "Admin Owner"],
      ["From the reviewer", "Reviewer Rita"],
    ]);
  });

  it("names the author in an updated comment too, so a live update does not lose the name", async () => {
    const { reviewerId, documentId, url } = await setup();
    const created = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${token(reviewerId)}`)
      .send({ body: "Draft" });

    const res = await request(app)
      .patch(`${base}/${documentId}/comments/${created.body.id}`)
      .set("Authorization", `Bearer ${token(reviewerId)}`)
      .send({ body: "Final" });

    expect(res.status).toBe(200);
    expect(res.body.authorDisplayName).toBe("Reviewer Rita");
  });
});
