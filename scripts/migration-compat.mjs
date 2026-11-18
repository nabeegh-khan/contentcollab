// Fails when a migration's up drops or renames a table or column without a contract marker (#105, ARCHITECTURE D24).
// Usage: node scripts/migration-compat.mjs <migrations folder>. Exit 0 clean, 1 on a violation, 2 on a usage error.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// An identifier as written in SQL: optionally schema-qualified and double-quoted ("public"."Users", public.users, users)
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?`;
// Where up and down are declared: exported directly, declared and exported later (export { up }, module.exports), or exports.up =
const UP_START = /\b(?:const|let|var)\s+up\s*=|\b(?:async\s+)?function\s+up\s*\(|\bexports\.up\s*=/;
const DOWN_START =
  /\b(?:const|let|var)\s+down\s*=|\b(?:async\s+)?function\s+down\s*\(|\bexports\.down\s*=/;
// "contract: <table>" or "contract: <table>.<column>", read only inside comments
const MARKER = /contract:\s*([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi;
// Comments: block (SQL and JS); "--" (SQL) and "//" (JS) at a line start or after a space, and "//" after ; , ) or }.
// "i--", "'--'" and "http://" are not comments, so they are left alone.
const COMMENTS = /\/\*[\s\S]*?\*\/|(?<=^|[ \t])--[^\n]*|(?<=^|[ \t;,)}])\/\/[^\n]*/gm;
// What follows DROP inside ALTER TABLE without naming a column (these relax, they do not remove a column)
const NOT_A_COLUMN = new Set(["constraint", "default", "not", "expression", "identity"]);

/** Last part of a possibly schema-qualified, possibly quoted name, lower-cased: "public"."Users" -> users */
function bareName(raw) {
  const last = raw.split(/\s*\.\s*(?=(?:"|[A-Za-z_]))/).pop();
  return last.replace(/^"|"$/g, "").toLowerCase();
}

/** Same length as the input, with comments blanked, so offsets and line numbers still match */
function blankComments(text) {
  return text.replace(COMMENTS, (m) => m.replace(/[^\n]/g, " "));
}

/** The contract markers written in the file's comments, lower-cased */
function contractMarkers(source) {
  const comments = source.match(COMMENTS) ?? [];
  return new Set(comments.flatMap((c) => [...c.matchAll(MARKER)].map((m) => m[1].toLowerCase())));
}

/** [start, end) of up's source; down and anything before up are left out. No up found is an error */
function upRange(source) {
  const code = blankComments(source);
  const up = UP_START.exec(code);
  if (!up) throw new Error("no up function found (export const up, function up, or exports.up)");
  const down = DOWN_START.exec(code.slice(up.index + up[0].length));
  return [up.index, down ? up.index + up[0].length + down.index : source.length];
}

/** Each SQL statement's text and offset: split on ";" (identifiers in this project hold none) */
function* statements(text) {
  let start = 0;
  for (const part of text.split(";")) {
    yield { text: part, offset: start };
    start += part.length + 1;
  }
}

function sqlTargets(statement) {
  const found = [];
  const s = statement.text;
  const dropTable = new RegExp(
    String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:${IDENT})(?:\s*,\s*${IDENT})*)`,
    "i",
  ).exec(s);
  if (dropTable) {
    for (const name of dropTable[1].split(/\s*,\s*(?=(?:"|[A-Za-z_]))/))
      found.push({ object: bareName(name), index: dropTable.index });
  }
  const alter = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${IDENT})`,
    "i",
  ).exec(s);
  if (alter) {
    const table = bareName(alter[1]);
    const actions = s.slice(alter.index + alter[0].length);
    const base = alter.index + alter[0].length;
    const drop = new RegExp(String.raw`\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${IDENT})`, "gi");
    for (let m; (m = drop.exec(actions));) {
      const column = bareName(m[1]);
      // "ALTER COLUMN x DROP DEFAULT" and "DROP CONSTRAINT k" leave every column in place
      if (!NOT_A_COLUMN.has(column))
        found.push({ object: `${table}.${column}`, index: base + m.index });
    }
    const renameTable = /\bRENAME\s+TO\b/i.exec(actions);
    if (renameTable) found.push({ object: table, index: base + renameTable.index });
    const renameColumn = new RegExp(
      String.raw`\bRENAME\s+(?:COLUMN\s+)?(${IDENT})\s+TO\b`,
      "i",
    ).exec(actions);
    if (renameColumn && bareName(renameColumn[1]) !== "constraint") {
      found.push({
        object: `${table}.${bareName(renameColumn[1])}`,
        index: base + renameColumn.index,
      });
    }
  }
  return found.map((t) => ({ ...t, index: statement.offset + t.index }));
}

// A JS string literal in any of the three quotes; one capture group, read with stringValue()
const QUOTED = String.raw`('[^']+'|"[^"]+"|\x60[^\x60]+\x60)`;
const stringValue = (literal) => literal.slice(1, -1);

function builderTargets(text) {
  const found = [];
  const tableCall = new RegExp(
    String.raw`pgm\s*\.\s*(?:dropTable|renameTable)\s*\(\s*${QUOTED}`,
    "g",
  );
  for (let m; (m = tableCall.exec(text));)
    found.push({ object: bareName(stringValue(m[1])), index: m.index });
  const renameColumn = new RegExp(
    String.raw`pgm\s*\.\s*renameColumn\s*\(\s*${QUOTED}\s*,\s*${QUOTED}`,
    "g",
  );
  for (let m; (m = renameColumn.exec(text));) {
    found.push({
      object: `${bareName(stringValue(m[1]))}.${bareName(stringValue(m[2]))}`,
      index: m.index,
    });
  }
  // dropColumns(table, column | [columns] | { column: ... }); dropColumn is its alias
  const dropColumns = new RegExp(
    String.raw`pgm\s*\.\s*dropColumns?\s*\(\s*${QUOTED}\s*,\s*(\[[^\]]*\]|\{[^}]*\}|${QUOTED})`,
    "g",
  );
  for (let m; (m = dropColumns.exec(text));) {
    const table = bareName(stringValue(m[1]));
    const list = m[2];
    const names = list.startsWith("{")
      ? [...list.matchAll(new RegExp(String.raw`(?:${QUOTED}|([A-Za-z_][\w$]*))\s*:`, "g"))].map(
          (c) => (c[1] ? stringValue(c[1]) : c[2]),
        )
      : [...list.matchAll(new RegExp(QUOTED, "g"))].map((c) => stringValue(c[1]));
    for (const column of names)
      found.push({ object: `${table}.${bareName(column)}`, index: m.index });
  }
  return found;
}

/** Every drop or rename of a table or column in up that has no contract marker, in source order */
export function findViolations(source) {
  const markers = contractMarkers(source);
  const [start, end] = upRange(source);
  const up = blankComments(source).slice(start, end);
  const targets = [...builderTargets(up)];
  for (const statement of statements(up)) targets.push(...sqlTargets(statement));
  return targets
    .filter((t) => !markers.has(t.object))
    .sort((a, b) => a.index - b.index)
    .map((t) => {
      const at = start + t.index;
      const line = source.slice(0, at).split("\n").length;
      const statement = source.split("\n")[line - 1].trim();
      return { object: t.object, line, statement };
    });
}

function main(folder) {
  if (!folder) {
    console.error("usage: node scripts/migration-compat.mjs <migrations folder>");
    return 2;
  }
  let files;
  try {
    files = readdirSync(folder)
      .filter((f) => /\.(c|m)?js$/.test(f) && statSync(join(folder, f)).isFile())
      .sort();
  } catch (err) {
    console.error(`migration-compat: cannot read ${folder}: ${err.message}`);
    return 2;
  }
  let count = 0;
  for (const file of files) {
    let violations;
    try {
      violations = findViolations(readFileSync(join(folder, file), "utf8"));
    } catch (err) {
      // A file the check cannot read is not a pass
      console.error(`migration-compat: ${file}: ${err.message}`);
      return 2;
    }
    for (const v of violations) {
      count += 1;
      console.error(
        `${file}:${v.line}: up removes ${v.object} ("${v.statement}"). The previous release may still read it during a rolling update (D24). ` +
          `Move the drop or rename to a later release, or add a comment "contract: ${v.object}" once no deployed version reads it.`,
      );
    }
  }
  if (count === 0)
    console.log(`migration-compat: ${files.length} migration(s), no unmarked drop or rename in up`);
  return count === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv[2]);
