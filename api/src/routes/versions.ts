import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { Router } from "express";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";
import { parseUpload } from "../lib/parseUpload.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { copy, getStream, putStream, remove } from "../lib/storage.js";
import { z } from "zod";

const router = Router({ mergeParams: true });

type VersionRow = {
  id: string;
  document_id: string;
  number: number;
  filename: string;
  content_type: string;
  size: string; // PostgreSQL BIGINT - pg string
  checksum: string;
  uploaded_by: string;
  created_at: Date;
};

// -------------------------- GET: Get All Versions For A Document --------------------------------
// GET /documents/:documentId/versions
router.get(
  "/",
  requireAuth,
  requireRole("owner", "editor", "commenter", "viewer"),
  async (req, res) => {
    const documentId = res.locals.documentId as string;

    const rawLimit = req.query.limit;
    if (rawLimit !== undefined && typeof rawLimit !== "string") {
      throw new HttpError(400, "VALIDATION", "Invalid Query", [
        { field: "limit", message: "must be a single integer" },
      ]);
    }

    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (rawLimit !== undefined && !/^\d+$/.test(rawLimit))
    ) {
      throw new HttpError(400, "VALIDATION", "Invalid Query", [
        { field: "limit", message: "must be an integer from 1 to 100" },
      ]);
    }

    const rawCursor = req.query.cursor;
    if (rawCursor !== undefined && typeof rawCursor !== "string") {
      throw new HttpError(400, "VALIDATION", "Invalid Query", [
        { field: "cursor", message: "must be a single string" },
      ]);
    }

    let afterNumber: number | null = null;

    if (rawCursor !== undefined) {
      try {
        const decoded: unknown = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));

        if (typeof decoded !== "number" || !Number.isSafeInteger(decoded) || decoded < 1) {
          throw new Error("Invalid cursor");
        }

        afterNumber = decoded;
      } catch {
        throw new HttpError(400, "VALIDATION", "Invalid Query", [
          { field: "cursor", message: "invalid page cursor" },
        ]);
      }
    }

    const result = await pool.query<VersionRow>(
      `SELECT id, document_id, number, filename, content_type,
                size, checksum, uploaded_by, created_at
         FROM document_versions
         WHERE document_id = $1
           AND ($2::integer IS NULL OR number > $2::integer)
         ORDER BY number ASC
         LIMIT $3`,
      [documentId, afterNumber, limit + 1],
    );

    const hasNextPage = result.rows.length > limit;
    const page = result.rows.slice(0, limit);
    const last = page.at(-1);

    res.status(200).json({
      items: page.map((version) => ({
        id: version.id,
        documentId: version.document_id,
        number: version.number,
        filename: version.filename,
        contentType: version.content_type,
        size: Number(version.size),
        checksum: version.checksum,
        uploadedBy: version.uploaded_by,
        createdAt: version.created_at,
      })),
      nextCursor:
        hasNextPage && last ? Buffer.from(JSON.stringify(last.number)).toString("base64url") : null,
    });
  },
);

// -------------------------- GET: Get A Version by Id -----------------------------
// GET /documents/:documentId/versions/:versionId
router.get(
  "/:versionId",
  requireAuth,
  requireRole("owner", "editor", "commenter", "viewer"),
  async (req, res) => {
    const documentId = res.locals.documentId as string;
    const versionId = req.params.versionId;

    if (typeof versionId !== "string" || !z.uuid().safeParse(versionId).success) {
      throw new HttpError(400, "VALIDATION", "Invalid Version ID", [
        { field: "versionId", message: "invalid UUID" },
      ]);
    }

    const result = await pool.query<VersionRow>(
      `SELECT id, document_id, number, filename, content_type,
                size, checksum, uploaded_by, created_at
         FROM document_versions
         WHERE id = $1 AND document_id = $2`,
      [versionId, documentId],
    );

    const version = result.rows[0];
    if (!version) {
      throw new HttpError(404, "NOT_FOUND", "Version Not Found");
    }

    res.status(200).json({
      id: version.id,
      documentId: version.document_id,
      number: version.number,
      filename: version.filename,
      contentType: version.content_type,
      size: Number(version.size),
      checksum: version.checksum,
      uploadedBy: version.uploaded_by,
      createdAt: version.created_at,
    });
  },
);

// -------------------------- POST: Upload A New Version ----------------------------
// POST /documents/:documentId/versions
router.post("/", requireAuth, requireRole("owner", "editor"), async (req, res) => {
  const documentId = req.params.documentId;
  if (typeof documentId !== "string") {
    throw new HttpError(400, "VALIDATION", "Invalid Document ID", [
      { field: "documentId", message: "required" },
    ]);
  }

  const userId = res.locals.userId as string;
  const versionId = randomUUID();
  const objectKey = `documents/${documentId}/${versionId}`;

  const hash = createHash("sha256");
  let size = 0;
  let uploadStarted = false;
  let committed = false;

  try {
    const uploaded = await parseUpload(req, async (file, info, signal) => {
      const hashingStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          size += chunk.length;
          callback(null, chunk);
        },
      });

      file.pipe(hashingStream);
      uploadStarted = true;
      await putStream(objectKey, hashingStream, info.contentType, signal);
    });

    if (uploaded.title !== undefined) {
      throw new HttpError(400, "VALIDATION", "Invalid Upload Field", [
        { field: "title", message: "Not Allowed for a Version Upload" },
      ]);
    }

    const checksum = hash.digest("hex");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const document = await client.query("SELECT id FROM documents WHERE id = $1 FOR UPDATE", [
        documentId,
      ]);
      if (!document.rows[0]) {
        throw new HttpError(404, "NOT_FOUND", "Document Not Found");
      }

      // Check Duplicated
      const duplicate = await client.query(
        `SELECT id FROM document_versions
           WHERE document_id = $1 AND checksum = $2
           LIMIT 1`,
        [documentId, checksum],
      );
      if (duplicate.rows[0]) {
        throw new HttpError(409, "CONFLICT", "File Already Uploaded");
      }

      const nextNumber = await client.query<{ number: number }>(
        `SELECT COALESCE(MAX(number), 0) + 1 AS number
           FROM document_versions
           WHERE document_id = $1`,
        [documentId],
      );

      const result = await client.query<VersionRow>(
        `INSERT INTO document_versions
             (id, document_id, number, filename, content_type,
              size, checksum, object_key, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, document_id, number, filename, content_type,
                     size, checksum, uploaded_by, created_at`,
        [
          versionId,
          documentId,
          nextNumber.rows[0]!.number,
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
           SET current_version_id = $2,
               row_version = row_version + 1,
               updated_at = NOW()
           WHERE id = $1`,
        [documentId, versionId],
      );

      await client.query("COMMIT");
      committed = true;

      const version = result.rows[0]!;
      res.status(201).json({
        id: version.id,
        documentId: version.document_id,
        number: version.number,
        filename: version.filename,
        contentType: version.content_type,
        size: Number(version.size),
        checksum: version.checksum,
        uploadedBy: version.uploaded_by,
        createdAt: version.created_at,
      });
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK").catch((rollbackError: unknown) => {
          console.error("Failed to roll back version upload", rollbackError);
        });
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (uploadStarted && !committed) {
      await remove(objectKey).catch((cleanupError: unknown) => {
        console.error("Failed to remove uploaded object", cleanupError);
      });
    }
    throw error;
  }
});

// -------------------------- GET: Download A Version --------------------------------
// GET /documents/:documentId/versions/:versionId/content
router.get(
  "/:versionId/content",
  requireAuth,
  requireRole("owner", "editor", "commenter", "viewer"),
  async (req, res, next) => {
    const { documentId, versionId } = req.params;

    if (
      typeof documentId !== "string" ||
      typeof versionId !== "string" ||
      !z.uuid().safeParse(documentId).success ||
      !z.uuid().safeParse(versionId).success
    ) {
      throw new HttpError(400, "VALIDATION", "Invalid ID", [
        { field: "versionId", message: "invalid UUID" },
      ]);
    }

    const result = await pool.query<{
      filename: string;
      content_type: string;
      size: string;
      object_key: string;
    }>(
      `SELECT filename, content_type, size, object_key
       FROM document_versions
       WHERE id = $1 AND document_id = $2`,
      [versionId, documentId],
    );

    const version = result.rows[0];
    if (!version) {
      throw new HttpError(404, "NOT_FOUND", "Version Not Found");
    }

    const stream = await getStream(version.object_key);

    const safeName = version.filename.replace(/[/\\\r\n"]/g, "_").replace(/[\x00-\x1F\x7F]/g, "_");

    const asciiName = safeName.replace(/[^\x20-\x7E]/g, "_") || "download";

    const encodedName = encodeURIComponent(safeName).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    );
    res.setHeader("Content-Type", version.content_type);
    res.setHeader("Content-Length", version.size);

    stream.once("error", (error) => {
      if (res.headersSent) {
        res.destroy(error);
      } else {
        next(error);
      }
    });

    res.once("close", () => {
      if (!res.writableEnded) stream.destroy();
    });

    stream.pipe(res);
  },
);

// -------------------------- POST: Revert To A Old Version ----------------------------
// POST /documents/:documentId/versions/:versionId/revert
router.post("/:versionId/revert", requireAuth, requireRole("owner", "editor"), async (req, res) => {
  const { documentId, versionId: sourceVersionId } = req.params;

  if (
    typeof documentId !== "string" ||
    typeof sourceVersionId !== "string" ||
    !z.uuid().safeParse(documentId).success ||
    !z.uuid().safeParse(sourceVersionId).success
  ) {
    throw new HttpError(400, "VALIDATION", "Invalid ID", [
      { field: "versionId", message: "invalid UUID" },
    ]);
  }

  // Check the reverted version belongs to this document, and is not the current verison
  const sourceResult = await pool.query<{
    object_key: string;
    filename: string;
    content_type: string;
    size: string;
    checksum: string;
    current_version_id: string | null;
  }>(
    `SELECT v.object_key, v.filename, v.content_type, v.size, v.checksum,
                d.current_version_id
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
         WHERE v.id = $1 AND v.document_id = $2`,
    [sourceVersionId, documentId],
  );

  const source = sourceResult.rows[0];
  if (!source) {
    throw new HttpError(404, "NOT_FOUND", "Version Not Found");
  }
  if (source.current_version_id === sourceVersionId) {
    throw new HttpError(409, "CONFLICT", "Version Already Current");
  }

  const newVersionId = randomUUID();
  const newObjectKey = `documents/${documentId}/${newVersionId}`;
  let copyStarted = false;
  let committed = false;

  try {
    copyStarted = true;
    await copy(source.object_key, newObjectKey);

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const documentResult = await client.query<{
        current_version_id: string | null;
      }>(
        `SELECT current_version_id
             FROM documents
             WHERE id = $1
             FOR UPDATE`,
        [documentId],
      );

      const document = documentResult.rows[0];
      if (!document) {
        throw new HttpError(404, "NOT_FOUND", "Document Not Found");
      }
      if (document.current_version_id === sourceVersionId) {
        throw new HttpError(409, "CONFLICT", "Version Already Current");
      }

      const nextNumber = await client.query<{ number: number }>(
        `SELECT COALESCE(MAX(number), 0) + 1 AS number
             FROM document_versions
             WHERE document_id = $1`,
        [documentId],
      );

      const result = await client.query<VersionRow>(
        `INSERT INTO document_versions
               (id, document_id, number, filename, content_type,
                size, checksum, object_key, uploaded_by, reverted_from)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, document_id, number, filename, content_type,
                       size, checksum, uploaded_by, created_at`,
        [
          newVersionId,
          documentId,
          nextNumber.rows[0]!.number,
          source.filename,
          source.content_type,
          source.size,
          source.checksum,
          newObjectKey,
          res.locals.userId,
          sourceVersionId,
        ],
      );

      await client.query(
        `UPDATE documents
             SET current_version_id = $2,
                 row_version = row_version + 1,
                 updated_at = NOW()
             WHERE id = $1`,
        [documentId, newVersionId],
      );

      await client.query("COMMIT");
      committed = true;

      const version = result.rows[0]!;
      res.status(201).json({
        id: version.id,
        documentId: version.document_id,
        number: version.number,
        filename: version.filename,
        contentType: version.content_type,
        size: Number(version.size),
        checksum: version.checksum,
        uploadedBy: version.uploaded_by,
        createdAt: version.created_at,
      });
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK").catch((rollbackError: unknown) => {
          console.error("Failed to roll back revert", rollbackError);
        });
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (copyStarted && !committed) {
      await remove(newObjectKey).catch((cleanupError: unknown) => {
        console.error("Failed to remove copied object", cleanupError);
      });
    }
    throw error;
  }
});

export default router;
