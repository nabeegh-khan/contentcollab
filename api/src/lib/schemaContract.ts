// The #37 "Must cover" checklist as queries against the catalog (#77, DB-9,
// TST-5). Each check reads information_schema and pg_catalog and returns the
// ids of the promises the schema does not keep; it never writes.
export type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type Check = { id: string; promise: string; run: (db: Queryable) => Promise<boolean> };

const ROLES = ["commenter", "editor", "owner", "viewer"];
const QUOTE_PAIR = 2; // an opening and a closing quote

async function exists(db: Queryable, sql: string, params: unknown[] = []): Promise<boolean> {
  const { rows } = await db.query(`SELECT EXISTS (${sql}) AS ok`, params);
  return rows[0]?.ok === true;
}

const column =
  (table: string, name: string, notNull = false) =>
  (db: Queryable) =>
    exists(
      db,
      `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
        AND ($3::boolean IS FALSE OR is_nullable = 'NO')`,
      [table, name, notNull],
    );

// A UNIQUE constraint or unique index over exactly these columns, not partial
const uniqueOn = (table: string, columns: string[]) => (db: Queryable) =>
  exists(
    db,
    `SELECT 1 FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relname = $1 AND t.relnamespace = 'public'::regnamespace
        AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
        AND ARRAY(SELECT a.attname FROM pg_attribute a
                   WHERE a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
                   ORDER BY a.attname) = $2::name[]`,
    [table, [...columns].sort()],
  );

// A foreign key from table.column to target
const foreignKey = (table: string, name: string, target: string) => (db: Queryable) =>
  exists(
    db,
    `SELECT 1 FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conrelid = ('public.' || $1)::regclass
        AND c.confrelid = ('public.' || $3)::regclass
        AND ARRAY(SELECT a.attname FROM pg_attribute a
                   WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY[$2]::name[]`,
    [table, name, target],
  );

// The CHECK on shares.role names exactly the four roles, no more, no fewer
async function roleCheck(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.contype = 'c' AND c.conrelid = 'public.shares'::regclass
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                       AND a.attname = 'role')`,
  );
  return rows.some((row) => {
    // Splitting on ' leaves the quoted literals at the odd positions:
    // "role = ANY (ARRAY['owner'::text, 'viewer'::text])" gives owner and viewer
    const named = String(row.def)
      .split("'")
      .filter((_, position) => position % QUOTE_PAIR === 1);
    return [...new Set(named)].sort().join() === ROLES.join();
  });
}

// Some table with "mention" in its name that points at comments
const mentionsTable = (db: Queryable) =>
  exists(
    db,
    `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'f' AND c.confrelid = 'public.comments'::regclass
        AND t.relnamespace = 'public'::regnamespace AND t.relname LIKE '%mention%'`,
  );

// A column on comments that increases by itself: identity, or a sequence default
const increasingColumn = (db: Queryable) =>
  exists(
    db,
    `SELECT 1 FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.comments'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND (a.attidentity IN ('a', 'd') OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%')`,
  );

const tableExists = (name: string) => (db: Queryable) =>
  exists(
    db,
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );

// Every id below is a line of the #37 checklist; `promise` says where the proposal makes it
export const checks: Check[] = [
  {
    id: "users-password-hash",
    promise: "users.password_hash exists and is NOT NULL (2.7)",
    run: column("users", "password_hash", true),
  },
  {
    id: "shares-role-check",
    promise: "shares.role is limited to owner, editor, commenter, viewer by a CHECK (2.1)",
    run: roleCheck,
  },
  {
    id: "shares-link-token-unique",
    promise: "shares.link_token is unique (2.6)",
    run: uniqueOn("shares", ["link_token"]),
  },
  {
    id: "shares-expires-at",
    promise: "shares.expires_at exists (2.6)",
    run: column("shares", "expires_at"),
  },
  {
    id: "versions-checksum-unique",
    promise: "document_versions is unique on (document_id, checksum) (2.4)",
    run: uniqueOn("document_versions", ["document_id", "checksum"]),
  },
  {
    id: "documents-row-version",
    promise: "documents.row_version exists and is NOT NULL (2.4)",
    run: column("documents", "row_version", true),
  },
  {
    id: "comments-row-version",
    promise: "comments.row_version exists and is NOT NULL (2.4)",
    run: column("comments", "row_version", true),
  },
  {
    id: "comments-parent-fk",
    promise: "comments.parent_id references comments (2.6)",
    run: foreignKey("comments", "parent_id", "comments"),
  },
  {
    id: "comments-anchor",
    promise: "comments.anchor exists (2.6)",
    run: column("comments", "anchor"),
  },
  {
    id: "mentions-table",
    promise: "a mentions table references comments (2.6)",
    run: mentionsTable,
  },
  {
    id: "comments-increasing-column",
    promise:
      "comments has an identity or sequence column, so a client can fetch what it missed (2.4)",
    run: increasingColumn,
  },
  { id: "tags-table", promise: "tags exists (#43)", run: tableExists("tags") },
  {
    id: "document-tags-fks",
    promise: "document_tags has foreign keys to documents and tags (#43)",
    run: async (db) =>
      (await foreignKey("document_tags", "document_id", "documents")(db)) &&
      (await foreignKey("document_tags", "tag_id", "tags")(db)),
  },
];

// The ids of the checklist lines the schema in `db` does not keep, in checklist order
export async function schemaViolations(db: Queryable): Promise<string[]> {
  // One query at a time on the one connection. A missing table makes the
  // catalog cast throw: that counts as a violation.
  const failed = await checks.reduce<Promise<string[]>>(async (soFar, check) => {
    const ids = await soFar;
    const ok = await check.run(db).catch(() => false);
    return ok ? ids : [...ids, check.id];
  }, Promise.resolve([]));
  return failed;
}
