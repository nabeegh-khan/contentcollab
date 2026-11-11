import type { RequestHandler } from "express";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";

export type DocumentRole = "owner" | "editor" | "commenter" | "viewer";

export function requireRole(...allowedRoles: DocumentRole[]): RequestHandler {
  return async (req, res, next) => {
    const documentId = req.params.documentId;
    const userId = res.locals.userId as string | undefined;

    // Verify Token First
    if (!userId) {
      throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
    }

    if (typeof documentId !== "string") {
      throw new HttpError(
        400,
        "VALIDATION",
        "Invalid Document ID",
        [{ field: "documentId", message: "required" }]
      );
    }

    const result = await pool.query<{ role: DocumentRole }>(
      `SELECT role
       FROM shares
       WHERE document_id = $1
         AND user_id = $2
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [documentId, userId],
    );

    const share = result.rows[0];

    if (!share) {
      throw new HttpError(404, "NOT_FOUND", "Document Not Found");
    }

    if (!allowedRoles.includes(share.role)) {
      throw new HttpError(403, "FORBIDDEN", "Forbidden");
    }

    res.locals.documentShareRole = share.role;
    res.locals.documentId = documentId;
    next();
  };
}
