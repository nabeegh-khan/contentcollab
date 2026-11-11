// The #37 "Must cover" checklist as queries against the catalog (#77, DB-9,
// TST-5). Each check reads information_schema and pg_catalog and returns the
// ids of the promises the schema does not keep. Nothing is written to the
// schema; the role check works on a temporary copy inside a rolled-back
// transaction.
export type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type Check = { id: string; promise: string; run: (db: Queryable) => Promise<boolean> };

const ROLES = ["commenter", "editor", "owner", "viewer"];
const NOT_ROLES = ["admin", "xyz"];
const INTEGERS = ["smallint", "integer", "bigint"];

async function exists(db: Queryable, sql: string, params: unknown[] = []): Promise<boolean> {
  const { rows } = await db.query(`SELECT EXISTS (${sql}) AS ok`, params);
  return rows[0]?.ok === true;
}

// A column of this table, optionally NOT NULL and of one of these data types
const column =
  (table: string, name: string, notNull = false, types: string[] = []) =>
  (db: Queryable) =>
    exists(
      db,
      `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
        AND ($3::boolean IS FALSE OR is_nullable = 'NO')
        AND (cardinality($4::text[]) = 0 OR data_type = ANY ($4::text[]))`,
      [table, name, notNull, types],
    );

// A valid UNIQUE constraint or unique index over exactly these columns (INCLUDE
// columns do not count), not partial and not on an expression
const uniqueOn = (table: string, columns: string[]) => (db: Queryable) =>
  exists(
    db,
    `SELECT 1 FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relname = $1 AND t.relnamespace = 'public'::regnamespace
        AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
        AND ARRAY(SELECT a.attname FROM pg_attribute a
                   WHERE a.attrelid = t.oid
                     AND a.attnum = ANY ((i.indkey::int2[])[0:i.indnkeyatts - 1])
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

// Keeps only the CHECKs on role in a temporary copy of shares and drops every NOT NULL,
// so an insert of one role value meets nothing but the role rule
const PROBE_SETUP = `
  DO $$
  DECLARE item record;
  BEGIN
    CREATE TEMP TABLE shares_probe (LIKE public.shares INCLUDING CONSTRAINTS) ON COMMIT DROP;
    FOR item IN
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'pg_temp.shares_probe'::regclass AND contype = 'c'
         AND NOT (conkey @> ARRAY[(SELECT attnum FROM pg_attribute
               WHERE attrelid = 'pg_temp.shares_probe'::regclass AND attname = 'role')])
    LOOP
      EXECUTE format('ALTER TABLE pg_temp.shares_probe DROP CONSTRAINT %I', item.conname);
    END LOOP;
    FOR item IN
      SELECT attname FROM pg_attribute
       WHERE attrelid = 'pg_temp.shares_probe'::regclass AND attnum > 0 AND NOT attisdropped
    LOOP
      EXECUTE format('ALTER TABLE pg_temp.shares_probe ALTER COLUMN %I DROP NOT NULL', item.attname);
    END LOOP;
  END $$`;

async function accepts(db: Queryable, role: string): Promise<boolean> {
  await db.query("SAVEPOINT probe");
  const inserted = await db
    .query("INSERT INTO shares_probe (role) VALUES ($1)", [role])
    .then(() => true)
    .catch(() => false);
  await db.query("ROLLBACK TO SAVEPOINT probe");
  return inserted;
}

// shares.role takes the four roles and refuses everything else: tried on a
// copy, so a CHECK that is always true, inverted or missing a role fails
async function roleCheck(db: Queryable): Promise<boolean> {
  await db.query("BEGIN");
  try {
    await db.query(PROBE_SETUP);
    const verdicts = await [...ROLES, ...NOT_ROLES].reduce<Promise<boolean[]>>(
      async (soFar, role) => [...(await soFar), await accepts(db, role)],
      Promise.resolve([]),
    );
    return verdicts.every((verdict, position) => verdict === position < ROLES.length);
  } finally {
    await db.query("ROLLBACK");
  }
}

// A table with "mention" in its name that points at both a comment and a user
const mentionsTable = (db: Queryable) =>
  exists(
    db,
    `SELECT 1 FROM pg_class t
      WHERE t.relnamespace = 'public'::regnamespace AND t.relkind = 'r' AND t.relname LIKE '%mention%'
        AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = t.oid AND c.contype = 'f'
                     AND c.confrelid = 'public.comments'::regclass)
        AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = t.oid AND c.contype = 'f'
                     AND c.confrelid = 'public.users'::regclass)`,
  );

// "Comments ordered by an increasing id per version": a column on comments that
// counts up on its own (identity or an owned sequence, positive step, no cycle)
// and is unique together with version_id
const increasingPerVersion = (db: Queryable) =>
  exists(
    db,
    `SELECT 1 FROM pg_attribute a
       JOIN pg_sequence s ON s.seqrelid = pg_get_serial_sequence('public.comments', a.attname)::regclass
      WHERE a.attrelid = 'public.comments'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND s.seqincrement > 0 AND NOT s.seqcycle
        AND EXISTS (
          SELECT 1 FROM pg_index i
           WHERE i.indrelid = a.attrelid AND i.indisunique AND i.indisvalid
             AND i.indpred IS NULL AND i.indexprs IS NULL
             AND ARRAY(SELECT k.attname::text FROM pg_attribute k
                        WHERE k.attrelid = i.indrelid
                          AND k.attnum = ANY ((i.indkey::int2[])[0:i.indnkeyatts - 1])
                        ORDER BY k.attname) = ARRAY(SELECT x FROM unnest(ARRAY['version_id', a.attname::text]) x ORDER BY x))`,
  );

// A base table, not a view
const tableExists = (name: string) => (db: Queryable) =>
  exists(
    db,
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1 AND table_type = 'BASE TABLE'`,
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
    promise: "shares.role takes owner, editor, commenter, viewer and nothing else (2.1)",
    run: roleCheck,
  },
  {
    id: "shares-link-token-unique",
    promise: "shares.link_token is unique (2.6)",
    run: uniqueOn("shares", ["link_token"]),
  },
  {
    id: "shares-expires-at",
    promise: "shares.expires_at exists and is a timestamp (2.6)",
    run: column("shares", "expires_at", false, ["timestamp with time zone"]),
  },
  {
    id: "versions-checksum-unique",
    promise: "document_versions is unique on (document_id, checksum) (2.4)",
    run: uniqueOn("document_versions", ["document_id", "checksum"]),
  },
  {
    id: "documents-row-version",
    promise: "documents.row_version is a NOT NULL integer (2.4)",
    run: column("documents", "row_version", true, INTEGERS),
  },
  {
    id: "comments-row-version",
    promise: "comments.row_version is a NOT NULL integer (2.4)",
    run: column("comments", "row_version", true, INTEGERS),
  },
  {
    id: "comments-parent-fk",
    promise: "comments.parent_id references comments (2.6)",
    run: foreignKey("comments", "parent_id", "comments"),
  },
  {
    id: "comments-anchor",
    promise: "comments.anchor exists and is JSON (2.6)",
    run: column("comments", "anchor", false, ["jsonb", "json"]),
  },
  {
    id: "mentions-table",
    promise: "a mentions table references a comment and a user (2.6)",
    run: mentionsTable,
  },
  {
    id: "comments-increasing-column",
    promise:
      "comments has a counting column, unique with version_id, so a client can fetch what it missed (2.4)",
    run: increasingPerVersion,
  },
  { id: "tags-table", promise: "tags is a table (#43)", run: tableExists("tags") },
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
  return checks.reduce<Promise<string[]>>(async (soFar, check) => {
    const ids = await soFar;
    const ok = await check.run(db).catch(() => false);
    return ok ? ids : [...ids, check.id];
  }, Promise.resolve([]));
}
