import { Router } from "express";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";


const router = Router();

type LinkRow = {
    document_id: string;
    title: string;
    owner_id: string;
    current_version_id: string | null;
    document_created_at: Date;
    document_updated_at: Date;
    role: "owner" | "editor" | "commenter" | "viewer";
    tags: string[];
  
    version_id: string | null;
    number: number | null;
    filename: string | null;
    content_type: string | null;
    size: string | null; // PostgreSQL BIGINT - pg string
    checksum: string | null;
    uploaded_by: string | null;
    version_created_at: Date | null;
  };
  
// GET 
router.get("/:linkToken", async (req, res) => {
    const linkToken = req.params.linkToken;
    if (typeof linkToken !== "string") {
      throw new HttpError(404, "NOT_FOUND", "Link Not Found");
    }

    const result = await pool.query<LinkRow>(
        `SELECT
           d.id AS document_id,
           d.title,
           d.owner_id,
           d.current_version_id,
           d.created_at AS document_created_at,
           d.updated_at AS document_updated_at,
           s.role,
           COALESCE(
             (
               SELECT array_agg(t.name ORDER BY t.name)
               FROM document_tags dt
               JOIN tags t ON t.id = dt.tag_id
               WHERE dt.document_id = d.id
             ),
             ARRAY[]::varchar[]
           ) AS tags,
           v.id AS version_id,
           v.number,
           v.filename,
           v.content_type,
           v.size,
           v.checksum,
           v.uploaded_by,
           v.created_at AS version_created_at
         FROM shares s
         JOIN documents d ON d.id = s.document_id
         LEFT JOIN document_versions v ON v.id = d.current_version_id
         WHERE s.link_token = $1
           AND (s.expires_at IS NULL OR s.expires_at > NOW())`,
        [linkToken],
      );
    
      const row = result.rows[0];
      if (!row) {
        throw new HttpError(404, "NOT_FOUND", "Link Not Found");
      }
    
      const document = {
        id: row.document_id,
        title: row.title,
        ownerId: row.owner_id,
        currentVersionId: row.current_version_id,
        role: row.role,
        tags: row.tags,
        createdAt: row.document_created_at,
        updatedAt: row.document_updated_at,
      };

      const version =
      row.version_id === null
        ? null
        : {
            id: row.version_id,
            documentId: row.document_id,
            number: row.number,
            filename: row.filename,
            contentType: row.content_type,
            size: Number(row.size),
            checksum: row.checksum,
            uploadedBy: row.uploaded_by,
            createdAt: row.version_created_at,
          };
  
    res.status(200).json({ document, version });
});

export default router;