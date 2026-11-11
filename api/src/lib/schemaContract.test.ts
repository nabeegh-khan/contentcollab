import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { checks, schemaViolations } from "./schemaContract.js";
import { connect, createDatabase, dropDatabase, migrate } from "./scratchDb.js";

// Schema contract (#77, DB-9, TST-5): the #37 checklist as assertions.
// Part 1 runs on any PostgreSQL and proves the checker can fail: it reads a
// deliberately bad schema and an empty one. Part 2 runs once api/package.json
// has a `migrate` script (#37): it builds the schema from empty with
// `npm run migrate`, expects no violations, then drops one promise at a time
// from a copy and expects the checker to name exactly that one.
const SLOW_MS = 120_000;
jest.setTimeout(SLOW_MS);

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const migrateExists = Boolean(packageJson.scripts?.["migrate"]);
const MIGRATE_UP = "npm run migrate -- up";

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

// One promise removed per row: the SQL, and the checklist id that must turn red
const mutations: [string, string][] = [
  ["users-password-hash", "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL"],
  ["shares-role-check", "ALTER TABLE shares DROP CONSTRAINT shares_role_check"],
  [
    "shares-role-check",
    `ALTER TABLE shares DROP CONSTRAINT shares_role_check,
       ADD CONSTRAINT shares_role_check CHECK (role IN ('owner','editor','commenter','viewer','admin'))`,
  ],
  ["shares-link-token-unique", "ALTER TABLE shares DROP CONSTRAINT shares_link_token_key"],
  ["shares-expires-at", "ALTER TABLE shares DROP COLUMN expires_at"],
  [
    "versions-checksum-unique",
    "ALTER TABLE document_versions DROP CONSTRAINT document_versions_checksum_unique",
  ],
  ["documents-row-version", "ALTER TABLE documents DROP COLUMN row_version"],
  ["comments-row-version", "ALTER TABLE comments DROP COLUMN row_version"],
  ["comments-parent-fk", "ALTER TABLE comments DROP CONSTRAINT comments_parent_id_fkey"],
  ["comments-anchor", "ALTER TABLE comments DROP COLUMN anchor"],
  ["mentions-table", "DROP TABLE comment_mentions"],
  ["comments-increasing-column", "ALTER TABLE comments DROP COLUMN sequence_number"],
  ["document-tags-fks", "ALTER TABLE document_tags DROP CONSTRAINT document_tags_tag_id_fkey"],
  ["document-tags-fks", "ALTER TABLE document_tags DROP CONSTRAINT document_tags_document_id_fkey"],
  ["document-tags-fks", "DROP TABLE document_tags"],
];

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

  it.each(mutations)("%s turns red when it is dropped: %s", async (id, sql) => {
    const copy = await createDatabase(template);
    created.push(copy);
    await runSql(copy, sql);
    expect(await violationsOf(copy)).toEqual([id]);
  });
});
