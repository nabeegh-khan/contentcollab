import { Router } from "express";
import { pool } from "../lib/db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

type TagRow = {
  name: string;
  count: number;
};

router.get("/", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;

  const result = await pool.query<TagRow>(
    `SELECT t.name, COUNT(DISTINCT dt.document_id)::int AS count
     FROM tags AS t
     JOIN document_tags AS dt ON dt.tag_id = t.id
     JOIN shares AS s
       ON s.document_id = dt.document_id
      AND s.user_id = $1
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
     GROUP BY t.id, t.name
     ORDER BY LOWER(t.name), t.name`,
    [userId],
  );

  res.status(200).json(result.rows);
});

export default router;
