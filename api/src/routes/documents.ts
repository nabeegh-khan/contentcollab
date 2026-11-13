import { createHash, randomUUID } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { Router } from "express";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";
import { parseUpload } from "../lib/parseUpload.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { putStream, remove } from "../lib/storage.js";
import { requireRole } from "../middleware/requireRole.js";
import { z } from "zod";
import { validate } from "../lib/validate.js";

const router = Router();

// ------------------------- GET: Get All Meta Information About the Document -----------------------
type DocumentListRow = DocumentRow & {
  role: "owner" | "editor" | "commenter" | "viewer";
  tags: string[];
  cursor_created_at: string;
};

type ListCursor = {
  createdAt: string;
  id: string;
};

function invalidQuery(field: string, message: string): HttpError {
  return new HttpError(400, "VALIDATION", "Invalid Query", [
    { field, message },
  ]);
}

function singleQueryValue(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidQuery(field, "must be a single string");
  }
  return value;
}

// GET /documents
router.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;

  const rawLimit = singleQueryValue(req.query.limit, "limit");
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (rawLimit !== undefined && !/^\d+$/.test(rawLimit))
  ) {
    throw invalidQuery("limit", "must be an integer from 1 to 100");
  }

  const q = singleQueryValue(req.query.q, "q")?.trim();
  const tag = singleQueryValue(req.query.tag, "tag")?.trim();
  const rawCursor = singleQueryValue(req.query.cursor, "cursor");

  let cursor: ListCursor | null = null;

  if (rawCursor !== undefined) {
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(rawCursor, "base64url").toString("utf8"),
      );

      if (
        typeof decoded !== "object" ||
        decoded === null ||
        !("createdAt" in decoded) ||
        !("id" in decoded) ||
        typeof decoded.createdAt !== "string" ||
        typeof decoded.id !== "string" ||
        Number.isNaN(Date.parse(decoded.createdAt)) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id)
      ) {
        throw new Error("Invalid cursor");
      }

      cursor = {
        createdAt: decoded.createdAt,
        id: decoded.id,
      };
    } catch {
      throw invalidQuery("cursor", "must be a valid page cursor");
    }
  }

  const result = await pool.query<DocumentListRow>(
    `SELECT
       d.id,
       d.title,
       d.owner_id,
       d.current_version_id,
       d.created_at,
       d.updated_at,
       d.created_at::text AS cursor_created_at,
       s.role,
       COALESCE(
         (
           SELECT array_agg(t.name ORDER BY t.name)
           FROM document_tags AS dt
           JOIN tags AS t ON t.id = dt.tag_id
           WHERE dt.document_id = d.id
         ),
         ARRAY[]::text[]
       ) AS tags
     FROM documents AS d
     JOIN shares AS s
       ON s.document_id = d.id
      AND s.user_id = $1
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
     WHERE ($2::text IS NULL OR d.title ILIKE '%' || $2 || '%')
       AND (
         $3::text IS NULL
         OR EXISTS (
           SELECT 1
           FROM document_tags AS dt_filter
           JOIN tags AS t_filter ON t_filter.id = dt_filter.tag_id
           WHERE dt_filter.document_id = d.id
             AND LOWER(t_filter.name) = LOWER($3)
         )
       )
       AND (
         $4::timestamptz IS NULL
         OR (d.created_at, d.id) < ($4::timestamptz, $5::uuid)
       )
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT $6`,
    [
      userId,
      q || null,
      tag || null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );

  const hasNextPage = result.rows.length > limit;
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);

  const nextCursor =
    hasNextPage && last
      ? Buffer.from(
          JSON.stringify({
            createdAt: last.cursor_created_at,
            id: last.id,
          }),
        ).toString("base64url")
      : null;

  res.status(200).json({
    items: page.map((document) => ({
      id: document.id,
      title: document.title,
      ownerId: document.owner_id,
      currentVersionId: document.current_version_id,
      role: document.role,
      tags: document.tags,
      createdAt: document.created_at,
      updatedAt: document.updated_at,
    })),
    nextCursor,
  });
});

// ------------------------- POST: Create A Document --------------------------------
type DocumentRow = {
  id: string;
  title: string;
  owner_id: string;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
};

// New document no share，only check login, requireRole no need
// POST /document
router.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const documentId = randomUUID();
  const versionId = randomUUID();
  const objectKey = `documents/${documentId}/${versionId}`;

  const hash = createHash("sha256");
  let size = 0;
  let objectUploadStarted = false;

  try {
    const uploaded = await parseUpload(req, async (file, info, signal) => {

      // Transform send data to storage
      const countingStream = new Transform({
        transform(
          chunk: Buffer,
          _encoding: BufferEncoding,
          callback: TransformCallback,
        ) {
          hash.update(chunk);
          size += chunk.length;
          callback(null, chunk);
        },
      });

      file.pipe(countingStream);
      objectUploadStarted = true;

      await putStream(
        objectKey,
        countingStream,
        info.contentType,
        signal,
      );
    });

    // parseUpload resolves only after both the file stream and putStream have completed successfully.
    const checksum = hash.digest("hex");
    const title = uploaded.title?.trim() || uploaded.filename;

    if (title.length > 255) {
      throw new HttpError(400, "VALIDATION", "Invalid Title", [
        { field: "title", message: "must be at most 255 characters" },
      ]);
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Set current_version_id as NULL temporarily
      // Table versions have a foreign key of documents
      const documentResult = await client.query<DocumentRow>(
        `INSERT INTO documents (id, title, owner_id)
         VALUES ($1, $2, $3)
         RETURNING id, title, owner_id, current_version_id,
                   created_at, updated_at`,
        [documentId, title, userId],
      );

      await client.query(
        `INSERT INTO document_versions
            (id, document_id, number, filename, content_type,
            size, checksum, object_key, uploaded_by, reverted_from)
          VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, NULL)`,
        [
          versionId,
          documentId,
          uploaded.filename,
          uploaded.contentType,
          size,
          checksum,
          objectKey,
          userId,
        ],
      );

      await client.query(
        `UPDATE documents
         SET current_version_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [documentId, versionId],
      );

      await client.query(
        `INSERT INTO shares (document_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [documentId, userId],
      );

      await client.query("COMMIT");

      const document = documentResult.rows[0]!;
      res.status(201).json({
        id: document.id,
        title: document.title,
        ownerId: document.owner_id,
        currentVersionId: versionId,
        role: "owner",
        tags: [],
        createdAt: document.created_at,
        updatedAt: document.updated_at,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    // If any steps fail, try to delete / remove the object.
    if (objectUploadStarted) {
      await remove(objectKey).catch((cleanupError: unknown) => {
        console.error("Failed to clean up uploaded object", cleanupError);
      });
    }
    throw error;
  }
});

// ------------------------- GET: Get A Document Information By ID ----------------------------
// GET /documents/:documentId
router.get(
  "/:documentId",
  requireAuth,
  requireRole("owner", "editor", "commenter", "viewer"),
  async (req, res) => {
    const documentId = res.locals.documentId as string;

    const result = await pool.query<
      DocumentRow & { tags: string[] }
    >(
      `SELECT
         d.id,
         d.title,
         d.owner_id,
         d.current_version_id,
         d.created_at,
         d.updated_at,
         COALESCE(
           array_agg(t.name ORDER BY t.name)
             FILTER (WHERE t.id IS NOT NULL),
           ARRAY[]::text[]
         ) AS tags
       FROM documents AS d
       LEFT JOIN document_tags AS dt ON dt.document_id = d.id
       LEFT JOIN tags AS t ON t.id = dt.tag_id
       WHERE d.id = $1
       GROUP BY d.id`,
      [documentId],
    );

    const document = result.rows[0];
    if (!document) {
      throw new HttpError(404, "NOT_FOUND", "Document Not Found");
    }

    res.status(200).json({
      id: document.id,
      title: document.title,
      ownerId: document.owner_id,
      currentVersionId: document.current_version_id,
      role: res.locals.documentShareRole,
      tags: document.tags,
      createdAt: document.created_at,
      updatedAt: document.updated_at,
    });
  },
);

// ------------------------- PATCH: Chaneg The Meta Information of A Document ------------------------
const patchDocumentSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(255).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).optional(),
  })
  .refine(
    (body) => body.title !== undefined || body.tags !== undefined,
    { message: "provide title or tags" },
  );

type PatchDocumentBody = z.infer<typeof patchDocumentSchema>;

// PATCH /documents/:documentId
router.patch(
  "/:documentId",
  requireAuth,
  requireRole("owner", "editor"),
  validate(patchDocumentSchema),
  async (req, res) => {
    const documentId = res.locals.documentId as string;
    const { title, tags } = req.body as PatchDocumentBody;

    const uniqueTags =
      tags === undefined
        ? undefined
        : [...new Map(tags.map((name) => [name.toLowerCase(), name])).values()];

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const updated = await client.query<DocumentRow>(
        `UPDATE documents
         SET title = COALESCE($2, title),
             updated_at = NOW(),
             row_version = row_version + 1
         WHERE id = $1
         RETURNING id, title, owner_id, current_version_id,
                   created_at, updated_at`,
        [documentId, title ?? null],
      );

      const document = updated.rows[0];
      if (!document) {
        throw new HttpError(404, "NOT_FOUND", "Document Not Found");
      }

      if (uniqueTags !== undefined) {
        for (const name of uniqueTags) {
          await client.query(
            `INSERT INTO tags (name)
             VALUES ($1)
             ON CONFLICT DO NOTHING`,
            [name],
          );
        }

        await client.query(
          `DELETE FROM document_tags WHERE document_id = $1`,
          [documentId],
        );

        await client.query(
          `INSERT INTO document_tags (document_id, tag_id)
           SELECT $1, t.id
           FROM tags AS t
           WHERE LOWER(t.name) = ANY($2::text[])`,
          [documentId, uniqueTags.map((name) => name.toLowerCase())],
        );
      }

      const tagResult = await client.query<{ name: string }>(
        `SELECT t.name
         FROM document_tags AS dt
         JOIN tags AS t ON t.id = dt.tag_id
         WHERE dt.document_id = $1
         ORDER BY t.name`,
        [documentId],
      );

      await client.query("COMMIT");

      res.status(200).json({
        id: document.id,
        title: document.title,
        ownerId: document.owner_id,
        currentVersionId: document.current_version_id,
        role: res.locals.documentShareRole,
        tags: tagResult.rows.map((row) => row.name),
        createdAt: document.created_at,
        updatedAt: document.updated_at,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

// ---------------------------- DELETE: Delete a Document -------------------------------
// DELETE /documents/:documentId
router.delete(
  "/:documentId",
  requireAuth,
  requireRole("owner"),
  async (_req, res) => {
    const documentId = res.locals.documentId as string;
    const client = await pool.connect();
    let objectKeys: string[] = [];

    try {
      await client.query("BEGIN");

      // Lock the document to prevent modifications when same document are being uploaded.
      const documentResult = await client.query(
        `SELECT id FROM documents WHERE id = $1 FOR UPDATE`,
        [documentId],
      );

      if (documentResult.rowCount === 0) {
        throw new HttpError(404, "NOT_FOUND", "Document Not Found");
      }

      // Record all the objects need to be deleted from Spaces
      const versionsResult = await client.query<{ object_key: string }>(
        `SELECT object_key
         FROM document_versions
         WHERE document_id = $1`,
        [documentId],
      );
      objectKeys = versionsResult.rows.map((row) => row.object_key);

      await client.query(
        `DELETE FROM documents WHERE id = $1`,
        [documentId],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const cleanup = await Promise.allSettled(
      objectKeys.map((key) => remove(key)),
    );

    cleanup.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          "Failed to remove document object",
          objectKeys[index],
          result.reason,
        );
      }
    });

    res.sendStatus(204);
  },
);
export default router;