import type { RequestHandler } from "express";
import { pool } from "../lib/db.js";

export type DocumentRole = "owner" | "editor" | "commenter" | "viewer";

export function requireRole(...allowedRoles: DocumentRole[]): RequestHandler {
  return async (req, res, next) => {
    const documentId = req.params.documentId;
    const userId = res.locals.userId as string | undefined;

    // Verify Token First
    if (!userId) {
      res.status(401).json({
        error: "Unauthorized",
        code: "UNAUTHORIZED",
      });
      return;
    }

    if (typeof documentId !== "string") {
      res.status(400).json({
        error: "Invalid Document ID",
        code: "VALIDATION",
        details: [{ field: "documentId", message: "required" }],
      });
      return;
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
      res.status(404).json({
        error: "Document Not Found",
        code: "NOT_FOUND",
      });
      return;
    }

    if (!allowedRoles.includes(share.role)) {
      res.status(403).json({
        error: "Forbidden",
        code: "FORBIDDEN",
      });
      return;
    }

    res.locals.documentShareRole = share.role;
    res.locals.documentId = documentId;
    next();
  };
}