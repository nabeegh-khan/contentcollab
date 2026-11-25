import { Router } from "express";
import { pool } from "../lib/db.js";
import { HttpError } from "../lib/httpError.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

type ExportRow = {
  document_id: string;
  title: string;
  owner_id: string;
  current_version_id: string | null;
  document_created_at: Date;
  document_updated_at: Date;
  tags: string[];
  version_id: string | null;
  version_number: number | null;
  filename: string | null;
  content_type: string | null;
  size: number | null;
  checksum: string | null;
  uploaded_by: string | null;
  version_created_at: Date | null;
};

const columns = [
  "documentId",
  "title",
  "ownerId",
  "currentVersionId",
  "tags",
  "documentCreatedAt",
  "documentUpdatedAt",
  "versionId",
  "versionNumber",
  "filename",
  "contentType",
  "size",
  "checksum",
  "uploadedBy",
  "versionCreatedAt",
] as const;

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);

  // Prevent spreadsheet programs from interpreting user-controlled metadata
  // as a formula when the downloaded CSV is opened.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  return `"${text.replaceAll('"', '""')}"`;
}

router.get("/", requireAuth, async (req, res) => {
  const rawFormat = req.query.format;
  if (rawFormat !== "json" && rawFormat !== "csv") {
    throw new HttpError(400, "VALIDATION", "Invalid Export Format", [
      { field: "format", message: "must be json or csv" },
    ]);
  }

  const userId = res.locals.userId as string;
  const result = await pool.query<ExportRow>(
    `SELECT
       d.id AS document_id,
       d.title,
       d.owner_id,
       d.current_version_id,
       d.created_at AS document_created_at,
       d.updated_at AS document_updated_at,
       COALESCE(
         (SELECT array_agg(t.name ORDER BY t.name)
          FROM document_tags AS dt
          JOIN tags AS t ON t.id = dt.tag_id
          WHERE dt.document_id = d.id),
         ARRAY[]::text[]
       ) AS tags,
       v.id AS version_id,
       v.number AS version_number,
       v.filename,
       v.content_type,
       v.size,
       v.checksum,
       v.uploaded_by,
       v.created_at AS version_created_at
     FROM documents AS d
     LEFT JOIN document_versions AS v ON v.document_id = d.id
     WHERE d.owner_id = $1
     ORDER BY d.created_at DESC, d.id DESC, v.number ASC`,
    [userId],
  );

  const rows = result.rows;

  if (rawFormat === "json") {
    const documents = [...new Map(
      rows.map((row) => [
        row.document_id,
        {
          id: row.document_id,
          title: row.title,
          ownerId: row.owner_id,
          currentVersionId: row.current_version_id,
          tags: row.tags,
          createdAt: row.document_created_at,
          updatedAt: row.document_updated_at,
        },
      ]),
    ).values()];

    const versions = rows
      .filter((row) => row.version_id !== null)
      .map((row) => ({
        id: row.version_id,
        documentId: row.document_id,
        number: row.version_number,
        filename: row.filename,
        contentType: row.content_type,
        size: row.size,
        checksum: row.checksum,
        uploadedBy: row.uploaded_by,
        createdAt: row.version_created_at,
      }));

    res.attachment("contentcollab-export.json");
    res.status(200).json({ documents, versions });
    return;
  }

  const csvRows = rows.map((row) => [
    row.document_id,
    row.title,
    row.owner_id,
    row.current_version_id,
    row.tags.join("; "),
    row.document_created_at.toISOString(),
    row.document_updated_at.toISOString(),
    row.version_id,
    row.version_number,
    row.filename,
    row.content_type,
    row.size,
    row.checksum,
    row.uploaded_by,
    row.version_created_at?.toISOString(),
  ]);

  const csv = [
    columns.map(csvCell).join(","),
    ...csvRows.map((row) => row.map(csvCell).join(",")),
  ].join("\r\n") + "\r\n";

  res.attachment("contentcollab-export.csv");
  res.status(200).type("text/csv").send(csv);
});

export default router;