import { randomBytes } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { z } from "zod";
import { validate } from "../lib/validate.js";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";

const router = Router({ mergeParams: true });
router.use(requireAuth, requireRole("owner"));

const roleSchema = z.enum(["editor", "commenter", "viewer"]); // editable roles
const createShareSchema = z.union([
  z.strictObject({
    email: z.email(),
    role: roleSchema,
  }),
  z.strictObject({
    link: z.literal(true),
    role: roleSchema,
    expiresAt: z.iso.datetime().optional(),
  }),
]);

type ShareRow = {
  id: string;
  document_id: string;
  user_id: string | null;
  link_token: string | null;
  role: string;
  expires_at: Date | null;
  created_at: Date;
};

type DocumentParams = { documentId: string; shareId?: string };

function toShare(row: ShareRow) {
  return {
    id: row.id,
    documentId: row.document_id,
    userId: row.user_id,
    linkToken: row.link_token,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

const updateShareSchema = z
  .strictObject({
    role: roleSchema.optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .refine((body) => body.role !== undefined || body.expiresAt !== undefined, {
    message: "At least one field is required",
  });

// POST /documents/:documentId/shares
router.post("/", validate(createShareSchema), async (req, res) => {
  const documentId = req.params.documentId;

  if ("email" in req.body) {
    const user = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [req.body.email],
    );
    if (!user.rows[0]) {
      throw new HttpError(404, "NOT_FOUND", "User Not Found");
    }

    try {
      const result = await pool.query(
        `INSERT INTO shares (document_id, user_id, role)
           VALUES ($1, $2, $3)
           RETURNING id, document_id, user_id, role, expires_at, created_at`,
        [documentId, user.rows[0].id, req.body.role],
      );
      res.status(201).json(toShare(result.rows[0]));
      return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new HttpError(409, "CONFLICT", "User Already Shared");
      }
      throw error;
    }
  }

  if (req.body.link === true) {
    const token = randomBytes(32).toString("base64url");
    const result = await pool.query(
      `INSERT INTO shares (document_id, link_token, role, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id, document_id, link_token, role, expires_at, created_at`,
      [documentId, token, req.body.role, req.body.expiresAt ?? null],
    );
    res.status(201).json(toShare(result.rows[0]));
  }
});

// GET /documents/:documentId/shares
router.get<DocumentParams>("/", async (req, res) => {
  const documentId = req.params.documentId;
  if (typeof documentId !== "string") {
    throw new HttpError(400, "VALIDATION", "Invalid Document ID", [
      { field: "documentId", message: "required" },
    ]);
  }

  const rawLimit = req.query.limit;
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "VALIDATION", "Invalid Limit", [
      { field: "limit", message: "must be an integer from 1 to 100" },
    ]);
  }

  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  if (req.query.cursor !== undefined) {
    try {
      if (typeof req.query.cursor !== "string") throw new Error();
      const decoded: unknown = JSON.parse(
        Buffer.from(req.query.cursor, "base64url").toString("utf8"),
      );
      const parsed = z
        .strictObject({
          createdAt: z.iso.datetime(),
          id: z.uuid(),
        })
        .parse(decoded);

      cursorCreatedAt = parsed.createdAt;
      cursorId = parsed.id;
    } catch {
      throw new HttpError(400, "VALIDATION", "Invalid Cursor", [
        { field: "cursor", message: "invalid cursor" },
      ]);
    }
  }

  const result = await pool.query<ShareRow>(
    `SELECT id, document_id, user_id, link_token, role, expires_at, created_at
     FROM shares
     WHERE document_id = $1
       AND (
         $2::timestamptz IS NULL
         OR (created_at, id) < ($2::timestamptz, $3::uuid)
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $4`,
    [documentId, cursorCreatedAt, cursorId, limit + 1],
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);

  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            createdAt: last.created_at.toISOString(),
            id: last.id,
          }),
        ).toString("base64url")
      : null;

  res.status(200).json({
    items: rows.map(toShare),
    nextCursor,
  });
});

// PATCH /documents/:documentId/shares/:shareId
router.patch("/:shareId", validate(updateShareSchema), async (req, res) => {
  const { documentId, shareId } = req.params;
  if (typeof documentId !== "string" || typeof shareId !== "string") {
    throw new HttpError(400, "VALIDATION", "Invalid Share ID", [
      { field: "shareId", message: "required" },
    ]);
  }

  const existing = await pool.query<ShareRow>(
    `SELECT id, document_id, user_id, link_token, role, expires_at, created_at
     FROM shares
     WHERE id = $1 AND document_id = $2`,
    [shareId, documentId],
  );

  const share = existing.rows[0];
  if (!share) {
    throw new HttpError(404, "NOT_FOUND", "Share Not Found");
  }
  if (share.role === "owner") {
    throw new HttpError(403, "FORBIDDEN", "Owner Share Cannot Be Changed");
  }

  const { role, expiresAt } = req.body as z.infer<typeof updateShareSchema>;

  const updated = await pool.query<ShareRow>(
    `UPDATE shares
     SET role = COALESCE($3, role),
         expires_at = CASE
           WHEN $4::boolean THEN $5::timestamptz
           ELSE expires_at
         END
     WHERE id = $1 AND document_id = $2 AND role <> 'owner'
     RETURNING id, document_id, user_id, link_token, role, expires_at, created_at`,
    [shareId, documentId, role ?? null, expiresAt !== undefined, expiresAt ?? null],
  );

  if (!updated.rows[0]) {
    throw new HttpError(409, "CONFLICT", "Share Changed During Update");
  }
  res.status(200).json(toShare(updated.rows[0]));
});

// DELETE /documents/:documentId/shares/:shareId
router.delete<DocumentParams>("/:shareId", async (req, res) => {
  const { documentId, shareId } = req.params;
  if (typeof documentId !== "string" || typeof shareId !== "string") {
    throw new HttpError(400, "VALIDATION", "Invalid Share ID", [
      { field: "shareId", message: "required" },
    ]);
  }

  const existing = await pool.query<Pick<ShareRow, "id" | "user_id" | "role">>(
    `SELECT id, user_id, role
      FROM shares
      WHERE id = $1 AND document_id = $2`,
    [shareId, documentId],
  );

  const share = existing.rows[0];
  if (!share) {
    throw new HttpError(404, "NOT_FOUND", "Share Not Found");
  }

  if (share.role === "owner" && share.user_id === res.locals.userId) {
    throw new HttpError(403, "FORBIDDEN", "Cannot Remove Your Own Owner Share");
  }

  const deleted = await pool.query(
    `DELETE FROM shares
      WHERE id = $1 AND document_id = $2
        AND NOT (role = 'owner' AND user_id = $3)
      RETURNING id`,
    [shareId, documentId, res.locals.userId],
  );

  if (deleted.rowCount !== 1) {
    throw new HttpError(409, "CONFLICT", "Share Changed During Delete");
  }

  res.status(204).end();
});

export default router;
