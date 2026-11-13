import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { checks, schemaViolations } from "./schemaContract.js";
import { connect, createDatabase, dropDatabase, migrate } from "./scratchDb.js";

// Schema contract (#77, DB-9, TST-5): the #37 checklist as assertions.
// Part 1 runs on any PostgreSQL and proves the checker can fail: it reads a
// deliberately bad schema and an empty one. Part 2 runs once api/package.json
// has a `migrate` script (#37): it builds the schema from empty with
// `npm run migrate`, expects no violations, then removes or weakens one promise at a
// time in a copy and expects the checker to name exactly that one.
const SLOW_MS = 120_000;
jest.setTimeout(SLOW_MS);

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const migrateExists = Boolean(packageJson.scripts?.["migrate"]);
const MIGRATE_UP = "npm run migrate -- up";

// Replaces the role CHECK with this condition
function roleCheckWith(condition: string): string {
  return `ALTER TABLE shares DROP CONSTRAINT shares_role_check, ADD CONSTRAINT shares_role_check CHECK (${condition})`;
}

async function violationsOf(database: string): Promise<string[]> {
  const client = await connect(database);
  try {
    return await schemaViolations(client);
  } finally {
    await client.end();
  }
}

async function runSql(database: string, sql: string): Promise<void> {
  const client = await connect(database);
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

describe("the contract checker fails on a schema that breaks the checklist", () => {
  const created: string[] = [];
  afterAll(async () => {
    await Promise.all(created.map(dropDatabase));
  });

  it("reports every checklist line for an empty database", async () => {
    const database = await createDatabase();
    created.push(database);
    expect(await violationsOf(database)).toEqual(checks.map((check) => check.id));
  });

  it("reports exactly the six lines the bad migration breaks", async () => {
    const database = await createDatabase();
    created.push(database);
    const file = readFileSync("test-fixtures/bad-migrations/1_bad_schema.sql", "utf8");
    // node-pg-migrate marks the two halves of a .sql migration with these comments
    const up = file.split("-- Up Migration")[1]?.split("-- Down Migration")[0] ?? "";
    await runSql(database, up);
    expect(await violationsOf(database)).toEqual([
      "users-password-hash",
      "shares-role-check",
      "versions-checksum-unique",
      "comments-row-version",
      "mentions-table",
      "document-tags-fks",
    ]);
  });
});

// One promise removed or weakened per row: the ids that must turn red, then the SQL
const mutations: [string[], string][] = [
  [["users-password-hash"], "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL"],
  [["shares-role-check"], "ALTER TABLE shares DROP CONSTRAINT shares_role_check"],
  [["shares-role-check"], roleCheckWith("role IN ('owner','editor','commenter','viewer','admin')")],
  [["shares-role-check"], roleCheckWith("role IN ('owner','editor','commenter')")],
  [["shares-role-check"], roleCheckWith("role IN ('owner','editor','commenter','viewer') OR true")],
  [["shares-role-check"], roleCheckWith("role NOT IN ('owner','editor','commenter','viewer')")],
  [["shares-link-token-unique"], "ALTER TABLE shares DROP CONSTRAINT shares_link_token_key"],
  [
    ["shares-link-token-unique"],
    `ALTER TABLE shares DROP CONSTRAINT shares_link_token_key;
     CREATE UNIQUE INDEX shares_link_token_partial ON shares (link_token) WHERE role = 'viewer'`,
  ],
  [["shares-expires-at"], "ALTER TABLE shares DROP COLUMN expires_at"],
  [["shares-expires-at"], "ALTER TABLE shares ALTER COLUMN expires_at TYPE TEXT"],
  [
    ["versions-checksum-unique"],
    "ALTER TABLE document_versions DROP CONSTRAINT document_versions_checksum_unique",
  ],
  [
    ["versions-checksum-unique"],
    `ALTER TABLE document_versions DROP CONSTRAINT document_versions_checksum_unique;
     ALTER TABLE document_versions ADD CONSTRAINT checksum_alone UNIQUE (checksum)`,
  ],
  [["documents-row-version"], "ALTER TABLE documents DROP COLUMN row_version"],
  [["comments-row-version"], "ALTER TABLE comments DROP COLUMN row_version"],
  [
    ["comments-row-version"],
    `ALTER TABLE comments DROP CONSTRAINT comments_row_version_check;
     ALTER TABLE comments ALTER COLUMN row_version DROP DEFAULT, ALTER COLUMN row_version TYPE BOOLEAN USING TRUE`,
  ],
  [["comments-parent-fk"], "ALTER TABLE comments DROP CONSTRAINT comments_parent_id_fkey"],
  [
    ["comments-parent-fk"],
    `ALTER TABLE comments DROP CONSTRAINT comments_parent_id_fkey;
     ALTER TABLE comments ADD FOREIGN KEY (parent_id) REFERENCES documents(id)`,
  ],
  [["comments-anchor"], "ALTER TABLE comments DROP COLUMN anchor"],
  [["comments-anchor"], "ALTER TABLE comments DROP COLUMN anchor, ADD COLUMN anchor INTEGER"],
  [["mentions-table"], "DROP TABLE comment_mentions"],
  [["mentions-table"], "ALTER TABLE comment_mentions DROP COLUMN mentioned_user_id"],
  [
    ["mentions-table"],
    `DROP TABLE comment_mentions;
     CREATE TABLE junk_mention (id INT, comment_id UUID REFERENCES comments(id))`,
  ],
  [["comments-increasing-column"], "ALTER TABLE comments DROP COLUMN sequence_number"],
  [
    ["comments-increasing-column"],
    "ALTER TABLE comments ALTER COLUMN sequence_number SET INCREMENT BY -1",
  ],
  [["comments-increasing-column"], "ALTER TABLE comments ALTER COLUMN sequence_number SET CYCLE"],
  [
    ["comments-increasing-column"],
    "ALTER TABLE comments DROP CONSTRAINT comments_version_sequence_unique",
  ],
  [["tags-table", "document-tags-fks"], "DROP TABLE tags CASCADE"],
  [["document-tags-fks"], "ALTER TABLE document_tags DROP CONSTRAINT document_tags_tag_id_fkey"],
  [
    ["document-tags-fks"],
    "ALTER TABLE document_tags DROP CONSTRAINT document_tags_document_id_fkey",
  ],
  [["document-tags-fks"], "DROP TABLE document_tags"],
  [
    ["versions-checksum-unique"],
    `ALTER TABLE document_versions DROP CONSTRAINT document_versions_checksum_unique;
     ALTER TABLE document_versions ADD CONSTRAINT checksum_number UNIQUE (document_id, checksum, number)`,
  ],
  [
    ["shares-link-token-unique"],
    `ALTER TABLE shares DROP CONSTRAINT shares_link_token_key;
     CREATE UNIQUE INDEX shares_link_token_lower ON shares (lower(link_token))`,
  ],
  [
    ["shares-link-token-unique"],
    `ALTER TABLE shares DROP CONSTRAINT shares_link_token_key;
     CREATE INDEX shares_link_token_plain ON shares (link_token)`,
  ],
  [
    ["comments-parent-fk"],
    `ALTER TABLE comments DROP CONSTRAINT comments_parent_id_fkey;
     ALTER TABLE comments ADD FOREIGN KEY (author_id) REFERENCES comments(id)`,
  ],
  [
    ["document-tags-fks"],
    `ALTER TABLE document_tags DROP CONSTRAINT document_tags_tag_id_fkey;
     ALTER TABLE document_tags ADD FOREIGN KEY (tag_id) REFERENCES users(id)`,
  ],
  [
    ["mentions-table"],
    "ALTER TABLE comment_mentions DROP CONSTRAINT comment_mentions_comment_id_fkey",
  ],
  [
    ["comments-increasing-column"],
    `ALTER TABLE comments DROP CONSTRAINT comments_version_sequence_unique;
     CREATE UNIQUE INDEX comments_sequence_partial ON comments (version_id, sequence_number) WHERE resolved`,
  ],
  [
    ["tags-table", "document-tags-fks"],
    "DROP TABLE tags CASCADE; CREATE VIEW tags AS SELECT gen_random_uuid() AS id, 'x'::text AS name",
  ],
];

// Migrations without the script would silently switch the gated part off
it("has a migrate script whenever api/migrations exists", () => {
  expect(!existsSync("migrations") || migrateExists).toBe(true);
});

const whenMigrateExists = migrateExists ? describe : describe.skip;

whenMigrateExists("the schema built by `npm run migrate` keeps the checklist", () => {
  let template = "";
  const created: string[] = [];

  beforeAll(async () => {
    template = await createDatabase();
    await migrate(MIGRATE_UP, template);
  });
  afterAll(async () => {
    await Promise.all([...created, template].map(dropDatabase));
  });

  it("has no violations after migrating an empty database", async () => {
    expect(await violationsOf(template)).toEqual([]);
  });

  it("changes nothing on a second run", async () => {
    const snapshot = `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`;
    const read = async () => {
      const client = await connect(template);
      try {
        const [columns, applied] = await Promise.all([
          client.query(snapshot),
          client.query("SELECT name FROM pgmigrations ORDER BY id"),
        ]);
        return [columns.rows, applied.rows];
      } finally {
        await client.end();
      }
    };
    const before = await read();
    const output = await migrate(MIGRATE_UP, template);
    expect(output).toContain("No migrations to run");
    expect(await read()).toEqual(before);
  });

  it.each(mutations)("%j turns red after: %s", async (ids, sql) => {
    const copy = await createDatabase(template);
    created.push(copy);
    await runSql(copy, sql);
    expect(await violationsOf(copy)).toEqual(ids);
  });
});
