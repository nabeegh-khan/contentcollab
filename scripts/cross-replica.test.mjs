// Tests for the cross-replica script's entry: it refuses to run without its settings and says which.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./cross-replica.mjs", import.meta.url));

function run(env) {
  return spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

test("exits 1 and names every missing setting", () => {
  const result = run({});
  assert.equal(result.status, 1);
  for (const name of ["EMAIL", "PASSWORD", "DOCUMENT_ID", "VERSION_ID"]) {
    assert.match(result.stderr, new RegExp(name));
  }
});

test("exits 1 on ids that are not ids, before touching the network", () => {
  const result = run({ EMAIL: "a@b.co", PASSWORD: "x", DOCUMENT_ID: "nope", VERSION_ID: "nope" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DOCUMENT_ID and VERSION_ID/);
});
