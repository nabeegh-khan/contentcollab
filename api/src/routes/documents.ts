import { createHash, randomUUID } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { Router } from "express";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";
import { parseUpload } from "../lib/parseUpload.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { putStream, remove } from "../lib/storage.js";

const router = Router();

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

export default router;