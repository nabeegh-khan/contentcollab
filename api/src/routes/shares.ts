import { randomBytes } from 'node:crypto';
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { z } from "zod";
import { validate } from "../lib/validate.js";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";

const router = Router({ mergeParams: true });
router.use(requireAuth, requireRole("owner"));

const roleSchema = z.enum(["editor", "commenter", "viewer"]);
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
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") 
        {
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

  export default router;