// scripts/migration-compat.mjs (#105, ARCHITECTURE D24): a migration's up may not drop or rename a table or column without a contract marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { findViolations } from "./migration-compat.mjs";

const root = join(import.meta.dirname, "..");

// A migration in node-pg-migrate's ESM form, with the given bodies for up and down
function migration(up, down = "") {
  return `export const up = (pgm) => {\n${up}\n};\n\nexport const down = (pgm) => {\n${down}\n};\n`;
}

const sql = (text) => "pgm.sql(`\n" + text + "\n`);";
const objects = (source) => findViolations(source).map((v) => v.object);

test("the migrations on main pass", () => {
  const r = spawnSync(process.execPath, ["scripts/migration-compat.mjs", "api/migrations"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("DROP TABLE in up is flagged, one entry per table", () => {
  assert.deepEqual(objects(migration(sql("DROP TABLE comments;"))), ["comments"]);
  assert.deepEqual(objects(migration(sql("drop table if exists tags, document_tags cascade;"))), ["tags", "document_tags"]);
});

test("a dropped column is flagged as table.column, with or without the COLUMN keyword", () => {
  assert.deepEqual(objects(migration(sql("ALTER TABLE documents DROP COLUMN title;"))), ["documents.title"]);
  assert.deepEqual(objects(migration(sql("ALTER TABLE documents DROP title;"))), ["documents.title"]);
  assert.deepEqual(objects(migration(sql("ALTER TABLE IF EXISTS ONLY documents DROP COLUMN IF EXISTS title;"))), ["documents.title"]);
  assert.deepEqual(
    objects(migration(sql("ALTER TABLE shares DROP COLUMN role, ADD COLUMN kind TEXT, DROP COLUMN expires_at;"))),
    ["shares.role", "shares.expires_at"],
  );
});

test("relaxing changes pass: a constraint, an index, a default or NOT NULL dropped", () => {
  const relaxing = [
    "ALTER TABLE document_versions DROP CONSTRAINT document_versions_checksum_unique;",
    "ALTER TABLE document_versions DROP CONSTRAINT IF EXISTS document_versions_checksum_unique;",
    "DROP INDEX IF EXISTS shares_link_token_idx;",
    "ALTER TABLE documents ALTER COLUMN title DROP DEFAULT;",
    "ALTER TABLE documents ALTER COLUMN title DROP NOT NULL;",
    "ALTER TABLE document_versions ADD COLUMN reverted_from UUID REFERENCES document_versions(id);",
  ];
  for (const statement of relaxing) assert.deepEqual(objects(migration(sql(statement))), [], statement);
});

test("a renamed table or column is flagged under its old name", () => {
  assert.deepEqual(objects(migration(sql("ALTER TABLE comments RENAME TO notes;"))), ["comments"]);
  assert.deepEqual(objects(migration(sql("ALTER TABLE comments RENAME COLUMN body TO text;"))), ["comments.body"]);
  assert.deepEqual(objects(migration(sql("ALTER TABLE comments RENAME body TO text;"))), ["comments.body"]);
  assert.deepEqual(objects(migration(sql("ALTER TABLE comments RENAME CONSTRAINT a TO b;"))), []);
});

test("quotes and a schema prefix are dropped from the name", () => {
  assert.deepEqual(objects(migration(sql('DROP TABLE "public"."Comments";'))), ["comments"]);
  assert.deepEqual(objects(migration(sql('ALTER TABLE public.documents DROP COLUMN "Title";'))), ["documents.title"]);
});

test("the builder's drop and rename calls are flagged", () => {
  assert.deepEqual(objects(migration("pgm.dropTable('comments');")), ["comments"]);
  assert.deepEqual(objects(migration(`pgm.dropColumns("shares", ["role", "expires_at"]);`)), ["shares.role", "shares.expires_at"]);
  assert.deepEqual(objects(migration("pgm.dropColumns('shares', 'role');")), ["shares.role"]);
  assert.deepEqual(objects(migration("pgm.dropColumn('shares', 'role', { ifExists: true });")), ["shares.role"]);
  assert.deepEqual(objects(migration("pgm.renameTable('comments', 'notes');")), ["comments"]);
  assert.deepEqual(objects(migration("pgm.renameColumn('comments', 'body', 'text');")), ["comments.body"]);
});

test("down is not checked, in each export form", () => {
  const drop = sql("DROP TABLE comments;");
  assert.deepEqual(objects(migration(sql("CREATE TABLE comments (id UUID);"), drop)), []);
  assert.deepEqual(objects(`export async function down(pgm) {\n${drop}\n}\nexport async function up(pgm) {}\n`), []);
  assert.deepEqual(objects(`exports.up = (pgm) => {};\nexports.down = (pgm) => {\n${drop}\n};\n`), []);
  assert.deepEqual(objects(`exports.up = (pgm) => {\n${drop}\n};\n`), ["comments"]);
});

test("a drop that is only in a comment is not flagged", () => {
  assert.deepEqual(objects(migration(sql("-- DROP TABLE comments; waits for the next release\nSELECT 1;"))), []);
  assert.deepEqual(objects(migration(sql("/* ALTER TABLE shares DROP COLUMN role; */ SELECT 1;"))), []);
  assert.deepEqual(objects(migration("  // pgm.dropTable('comments');\n")), []);
});

test("a contract marker clears exactly the object it names", () => {
  const up = sql("-- contract: comments.body (no release since 2 Dec reads it)\nALTER TABLE comments DROP COLUMN body;");
  assert.deepEqual(objects(migration(up)), []);
  const js = "// contract: comments\npgm.dropTable('comments');";
  assert.deepEqual(objects(migration(js)), []);
  const other = sql("-- contract: comments.anchor\nALTER TABLE comments DROP COLUMN body;");
  assert.deepEqual(objects(migration(other)), ["comments.body"]);
  const tableOnly = sql("-- contract: comments\nALTER TABLE comments DROP COLUMN body;");
  assert.deepEqual(objects(migration(tableOnly)), ["comments.body"]);
});

test("each violation carries the line it is on", () => {
  const [v] = findViolations(migration(sql("SELECT 1;\nDROP TABLE comments;")));
  assert.equal(v.line, 4);
  assert.match(v.statement, /DROP TABLE comments/);
});

test("the CLI exits 1 and names the file and the object; 0 for a clean folder; 2 without a folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "migcompat-"));
  try {
    writeFileSync(join(dir, "1_ok.js"), migration(sql("CREATE TABLE notes (id UUID);"), sql("DROP TABLE notes;")));
    let r = spawnSync(process.execPath, ["scripts/migration-compat.mjs", dir], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);

    writeFileSync(join(dir, "2_bad.js"), migration(sql("ALTER TABLE comments DROP COLUMN body;")));
    r = spawnSync(process.execPath, ["scripts/migration-compat.mjs", dir], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2_bad\.js:4/);
    assert.match(r.stderr, /comments\.body/);
    assert.match(r.stderr, /contract: comments\.body/);

    r = spawnSync(process.execPath, ["scripts/migration-compat.mjs", join(dir, "missing")], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
