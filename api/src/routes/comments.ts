import { Router } from "express";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validate } from "../lib/validate.js";
import { emitToVersion, emitToUser } from "../lib/realtime.js";

const router = Router();

const commentRoles = ["owner", "editor", "commenter", "viewer"] as const;
const createCommentSchema = z.strictObject({
  body: z.string().min(1).max(5000),
  anchor: z
    .strictObject({
      page: z.number().int().min(1),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .optional(),
  parentId: z.uuid().optional(),
});

const createCommentRoles = ["owner", "editor", "commenter"] as const;
const updateCommentSchema = z
  .strictObject({
    body: z.string().min(1).max(5000).optional(),
    resolved: z.boolean().optional(),
  })
  .refine((data) => data.body !== undefined || data.resolved !== undefined, {
    message: "At least one field is required",
  });

router.patch(
  "/documents/:documentId/comments/:commentId",
  requireAuth,
  requireRole(...commentRoles),
  validate(updateCommentSchema),
  async (req, res) => {
    const { documentId, commentId } = req.params;
    const userId = res.locals.userId as string;
    const { body, resolved } = req.body as z.infer<typeof updateCommentSchema>;

    if (typeof commentId !== "string" || !z.uuid().safeParse(commentId).success) {
      throw new HttpError(400, "VALIDATION", "Invalid Comment ID");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const commentResult = await client.query<{
        id: string;
        authorId: string;
        rootId: string;
        rootAuthorId: string;
      }>(
        `WITH RECURSIVE ancestors AS (
           SELECT id, parent_id, author_id
           FROM comments
           WHERE id = $1

           UNION ALL

           SELECT parent.id, parent.parent_id, parent.author_id
           FROM comments parent
           JOIN ancestors child ON child.parent_id = parent.id
         )
         SELECT
           c.id,
           c.author_id AS "authorId",
           (SELECT id FROM ancestors WHERE parent_id IS NULL LIMIT 1) AS "rootId",
           (SELECT author_id FROM ancestors WHERE parent_id IS NULL LIMIT 1) AS "rootAuthorId"
         FROM comments c
         JOIN document_versions v ON v.id = c.version_id
         WHERE c.id = $1 AND v.document_id = $2
         FOR UPDATE OF c`,
        [commentId, documentId],
      );

      const comment = commentResult.rows[0];

      if (!comment) {
        throw new HttpError(404, "NOT_FOUND", "Comment Not Found");
      }

      if (body !== undefined && comment.authorId !== userId) {
        throw new HttpError(403, "FORBIDDEN", "Only the comment author can edit its body");
      }

      if (resolved !== undefined && comment.rootAuthorId !== userId) {
        throw new HttpError(403, "FORBIDDEN", "Only the thread author can resolve it");
      }

      if (body !== undefined && resolved !== undefined && comment.id === comment.rootId) {
        await client.query(
          `UPDATE comments
           SET body = $2,
               resolved = $3,
               updated_at = NOW(),
               row_version = row_version + 1
           WHERE id = $1`,
          [comment.id, body, resolved],
        );
      } else {
        if (body !== undefined) {
          await client.query(
            `UPDATE comments
             SET body = $2,
                 updated_at = NOW(),
                 row_version = row_version + 1
             WHERE id = $1`,
            [comment.id, body],
          );
        }

        if (resolved !== undefined) {
          await client.query(
            `UPDATE comments
             SET resolved = $2,
                 updated_at = NOW(),
                 row_version = row_version + 1
             WHERE id = $1`,
            [comment.rootId, resolved],
          );
        }
      }

      const responseId = resolved !== undefined ? comment.rootId : comment.id;

      const updatedResult = await client.query(
        `SELECT
           c.id,
           c.version_id AS "versionId",
           c.author_id AS "authorId",
           u.display_name AS "authorDisplayName",
           c.parent_id AS "parentId",
           c.body,
           c.anchor,
           c.resolved,
           c.created_at AS "createdAt",
           c.updated_at AS "updatedAt"
         FROM comments c
         LEFT JOIN users u ON u.id = c.author_id
         WHERE c.id = $1`,
        [responseId],
      );
      const updatedComment = updatedResult.rows[0];
      await client.query("COMMIT");
      emitToVersion(updatedComment.versionId, "comment:updated", updatedComment);
      res.status(200).json(updatedResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

router.post(
  "/documents/:documentId/versions/:versionId/comments",
  requireAuth,
  requireRole(...createCommentRoles),
  validate(createCommentSchema),
  async (req, res) => {
    const { documentId, versionId } = req.params;
    const authorId = res.locals.userId as string;
    const { body, anchor, parentId } = req.body as z.infer<typeof createCommentSchema>;

    if (typeof versionId !== "string" || !z.uuid().safeParse(versionId).success) {
      throw new HttpError(400, "VALIDATION", "Invalid Version ID");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const versionResult = await client.query(
        `SELECT id
         FROM document_versions
         WHERE id = $1 AND document_id = $2`,
        [versionId, documentId],
      );

      if (versionResult.rowCount === 0) {
        throw new HttpError(404, "NOT_FOUND", "Version Not Found");
      }

      if (parentId) {
        const parentResult = await client.query(
          `SELECT id
           FROM comments
           WHERE id = $1 AND version_id = $2`,
          [parentId, versionId],
        );

        if (parentResult.rowCount === 0) {
          throw new HttpError(400, "VALIDATION", "Parent comment must belong to the same version");
        }
      }

      const commentResult = await client.query(
        `WITH inserted AS (
           INSERT INTO comments (
             version_id, author_id, parent_id, body, anchor
           )
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING *
         )
         SELECT
           i.id,
           i.version_id AS "versionId",
           i.author_id AS "authorId",
           u.display_name AS "authorDisplayName",
           i.parent_id AS "parentId",
           i.body,
           i.anchor,
           i.resolved,
           i.created_at AS "createdAt",
           i.updated_at AS "updatedAt"
         FROM inserted i
         LEFT JOIN users u ON u.id = i.author_id`,
        [versionId, authorId, parentId ?? null, body, JSON.stringify(anchor ?? null)],
      );

      const comment = commentResult.rows[0];

      if (!comment) {
        throw new Error("Comment insert returned no row");
      }

      const mentionedNames = [
        ...new Set(
          Array.from(body.matchAll(/@([\w.-]+)/g), (match) => match[1])
            .filter((name): name is string => Boolean(name))
            .map((name) => name.toLowerCase()),
        ),
      ];
      const mentionedUserIds: string[] = [];
      if (mentionedNames.length > 0) {
        const mentionedUsers = await client.query<{ id: string }>(
          `SELECT DISTINCT u.id
           FROM users u
           JOIN shares s ON s.user_id = u.id
           WHERE s.document_id = $1
             AND (s.expires_at IS NULL OR s.expires_at > NOW())
             AND LOWER(u.display_name) = ANY($2::text[])`,
          [documentId, mentionedNames],
        );
        mentionedUserIds.push(...mentionedUsers.rows.map((user) => user.id));

        for (const user of mentionedUsers.rows) {
          await client.query(
            `INSERT INTO comment_mentions (comment_id, mentioned_user_id)
             VALUES ($1, $2)
             ON CONFLICT (comment_id, mentioned_user_id) DO NOTHING`,
            [comment.id, user.id],
          );
        }
      }

      await client.query("COMMIT");
      emitToVersion(versionId, "comment:created", comment);

      for (const userId of mentionedUserIds) {
        emitToUser(userId, "mention", {
          commentId: comment.id,
          documentId,
          from: authorId,
        });
      }
      res.status(201).json(comment);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

router.get(
  "/documents/:documentId/versions/:versionId/comments",
  requireAuth,
  requireRole(...commentRoles),
  async (req, res) => {
    const { documentId, versionId } = req.params;

    if (typeof versionId !== "string" || !z.uuid().safeParse(versionId).success) {
      throw new HttpError(400, "VALIDATION", "Invalid Version ID");
    }

    const resolvedParam = req.query.resolved;
    let resolved: boolean | undefined;

    if (resolvedParam !== undefined) {
      if (resolvedParam === "true") {
        resolved = true;
      } else if (resolvedParam === "false") {
        resolved = false;
      } else {
        throw new HttpError(400, "VALIDATION", "Invalid resolved filter");
      }
    }

    const limitParam = req.query.limit;
    let limit = 20;

    if (limitParam !== undefined) {
      if (
        typeof limitParam !== "string" ||
        !/^\d+$/.test(limitParam) ||
        Number(limitParam) < 1 ||
        Number(limitParam) > 100
      ) {
        throw new HttpError(400, "VALIDATION", "Invalid pagination limit");
      }

      limit = Number(limitParam);
    }

    const cursorParam = req.query.cursor;
    let cursor: string | null = null;

    if (cursorParam !== undefined) {
      if (typeof cursorParam !== "string") {
        throw new HttpError(400, "VALIDATION", "Invalid pagination cursor");
      }

      try {
        const decoded = Buffer.from(cursorParam, "base64url").toString("utf8");

        if (
          !/^[1-9]\d*$/.test(decoded) ||
          Buffer.from(decoded).toString("base64url") !== cursorParam
        ) {
          throw new Error("Invalid cursor");
        }

        cursor = decoded;
      } catch {
        throw new HttpError(400, "VALIDATION", "Invalid pagination cursor");
      }
    }

    const versionResult = await pool.query(
      `SELECT id
       FROM document_versions
       WHERE id = $1 AND document_id = $2`,
      [versionId, documentId],
    );

    if (versionResult.rowCount === 0) {
      throw new HttpError(404, "NOT_FOUND", "Version Not Found");
    }

    const result = await pool.query(
      `WITH RECURSIVE comment_roots AS (
        SELECT id, parent_id, id AS root_id
        FROM comments
        WHERE version_id = $1 AND parent_id IS NULL

        UNION ALL

        SELECT child.id, child.parent_id, roots.root_id
        FROM comments child
        JOIN comment_roots roots ON child.parent_id = roots.id
      )
      SELECT
        c.id,
        c.version_id AS "versionId",
        c.author_id AS "authorId",
        author.display_name AS "authorDisplayName",
        c.parent_id AS "parentId",
        c.body,
        c.anchor,
        root.resolved AS resolved,
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt",
        c.sequence_number::text AS "sequenceNumber"
      FROM comments c
      JOIN comment_roots roots ON roots.id = c.id
      JOIN comments root ON root.id = roots.root_id
      LEFT JOIN users author ON author.id = c.author_id
      WHERE c.version_id = $1
        AND ($2::boolean IS NULL OR root.resolved = $2)
        AND ($3::bigint IS NULL OR c.sequence_number > $3::bigint)
      ORDER BY c.sequence_number ASC
      LIMIT $4`,
      [versionId, resolved ?? null, cursor, limit + 1],
    );

    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit);
    const lastItem = items[items.length - 1];

    const nextCursor =
      hasMore && lastItem ? Buffer.from(lastItem.sequenceNumber).toString("base64url") : null;

    const publicItems = items.map(({ sequenceNumber, ...item }) => {
      void sequenceNumber;
      return item;
    });

    res.status(200).json({
      items: publicItems,
      nextCursor,
    });
  },
);

router.delete(
  "/documents/:documentId/comments/:commentId",
  requireAuth,
  requireRole(...commentRoles),
  async (req, res) => {
    const { documentId, commentId } = req.params;
    const userId = res.locals.userId as string;
    const documentRole = res.locals.documentShareRole as string;

    if (typeof commentId !== "string" || !z.uuid().safeParse(commentId).success) {
      throw new HttpError(400, "VALIDATION", "Invalid Comment ID");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query<{ id: string; authorId: string; versionId: string }>(
        `SELECT c.id, c.author_id AS "authorId",c.version_id AS "versionId"
         FROM comments c
         JOIN document_versions v ON v.id = c.version_id
         WHERE c.id = $1 AND v.document_id = $2
         FOR UPDATE OF c`,
        [commentId, documentId],
      );

      const comment = result.rows[0];

      if (!comment) {
        throw new HttpError(404, "NOT_FOUND", "Comment Not Found");
      }

      if (comment.authorId !== userId && documentRole !== "owner") {
        throw new HttpError(403, "FORBIDDEN", "Forbidden");
      }

      await client.query("DELETE FROM comments WHERE id = $1", [commentId]);

      await client.query("COMMIT");
      emitToVersion(comment.versionId, "comment:deleted", {
        id: commentId,
      });

      res.status(204).send();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

export default router;
