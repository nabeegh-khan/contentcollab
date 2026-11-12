import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { Router } from "express";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";
import { parseUpload } from "../lib/parseUpload.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { putStream, remove } from "../lib/storage.js";
import { getStream } from "../lib/storage.js";
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

// POST /documents/:documentId/versions
router.post(
  "/",
  requireAuth,
  requireRole("owner", "editor"),
  async (req, res) => {
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

        const document = await client.query(
          "SELECT id FROM documents WHERE id = $1 FOR UPDATE",
          [documentId],
        );
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
        await client.query("ROLLBACK").catch((rollbackError: unknown) => {
          console.error("Failed to roll back version upload", rollbackError);
        });
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
  },
);


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

    const safeName = version.filename
      .replace(/[/\\\r\n"]/g, "_")
      .replace(/[\x00-\x1F\x7F]/g, "_");

    const asciiName =
      safeName.replace(/[^\x20-\x7E]/g, "_") || "download";

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

export default router;