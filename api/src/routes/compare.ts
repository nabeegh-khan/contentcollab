// GET /documents/:documentId/versions/compare?from=&to= (#23, ARCHITECTURE D33): the line diff of two text versions.
// Sign-in and any role on the document, as for reading a version. Mounted before the versions router, so
// "compare" is never taken for a version id.
import { Router } from "express";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { lineDiff } from "../lib/diff.js";
import { diffWith, functionConfigFromEnv, redisInvocationStore } from "../lib/functionDiff.js";
import { HttpError } from "../lib/httpError.js";
import { HTTP_BAD_REQUEST, HTTP_PAYLOAD_TOO_LARGE } from "../lib/httpStatus.js";
import { redis } from "../lib/redis.js";
import { getStream } from "../lib/storage.js";
import {
  compareVersions,
  MAX_VERSION_BYTES,
  type CompareDeps,
  type VersionRow,
} from "../lib/versionCompare.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router({ mergeParams: true });

const query = z.object({ from: z.uuid(), to: z.uuid() });

async function loadVersion(documentId: string, versionId: string): Promise<VersionRow | null> {
  const result = await pool.query<{
    id: string;
    number: number;
    filename: string;
    content_type: string;
    size: string; // BIGINT: pg gives a string
    object_key: string;
  }>(
    `SELECT id, number, filename, content_type, size, object_key
       FROM document_versions
      WHERE id = $1 AND document_id = $2`,
    [versionId, documentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size),
    objectKey: row.object_key,
  };
}

/** The stored file as text; stops reading past the comparison limit, whatever the row said. */
async function readText(objectKey: string): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const stream = await getStream(objectKey);
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Buffer);
    bytes += buffer.length;
    if (bytes > MAX_VERSION_BYTES) {
      stream.destroy();
      throw new HttpError(HTTP_PAYLOAD_TOO_LARGE, "TOO_LARGE", "A version is too large to compare");
    }
    chunks.push(buffer);
  }
  // A leading byte order mark is not text: one version with it and one without would differ on line 1
  return Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "");
}

// The line diff goes to the DigitalOcean Function when FUNCTION_DIFF_URL and FUNCTION_AUTH_TOKEN are set,
// and falls back to the local diff on any failure (D39)
const diff = diffWith({
  config: functionConfigFromEnv(process.env),
  local: lineDiff,
  store: redisInvocationStore(redis),
});

const deps: CompareDeps = { loadVersion, readText, diff };

router.get(
  "/:documentId/versions/compare",
  requireAuth,
  requireRole("owner", "editor", "commenter", "viewer"),
  async (req, res) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        HTTP_BAD_REQUEST,
        "VALIDATION",
        "from and to must be version ids",
        parsed.error.issues.map((issue) => ({
          field: String(issue.path[0] ?? "query"),
          message: "invalid UUID",
        })),
      );
    }
    const documentId = res.locals.documentId as string;
    res.json(await compareVersions(documentId, parsed.data.from, parsed.data.to, deps));
  },
);

export default router;
