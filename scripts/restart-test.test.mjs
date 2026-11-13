// scripts/restart-test.sh against a stand-in kubectl (#68; DB-2, TST-4): a marker row must survive each event,
// and the test must not pass when nothing was restarted. Control flow only; runs on a real cluster are
// recorded in docs/DEMO_PERSISTENCE.md.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const SCRUBBED = /^(KUBECONFIG|KUBE_CONTEXT|NAMESPACE|DRAIN|TIMEOUT|STUB_.*)$/;
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restart-"));
  mkdirSync(join(dir, "bin"));
  const body = readFileSync(join(root, "scripts", "testdata", "restart-kubectl-stub.sh"), "utf8").replaceAll("\r\n", "\n");
  writeFileSync(join(dir, "bin", "kubectl"), `#!/usr/bin/env bash\n${body}`);
  chmodSync(join(dir, "bin", "kubectl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Refuses to run unless kubectl resolves to the stand-in; KUBECONFIG points nowhere
function run(env = {}) {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUBBED.test(k)));
  const full = { ...base, [pathKey]: `${join(dir, "bin")}${delimiter}${process.env[pathKey]}`, KUBECONFIG: join(dir, "none"), STUB_DIR: dir, RETRY_WAIT: "0", ...env };
  const found = spawnSync("bash", ["-c", "command -v kubectl"], { env: full, encoding: "utf8" }).stdout.trim();
  if (!found.includes(basename(dir))) throw new Error(`kubectl resolves to '${found}', not the stub: refusing to run`);
  const r = spawnSync("bash", ["scripts/restart-test.sh"], { cwd: root, env: full, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const calls = () => (existsSync(join(dir, "kubectl.argv")) ? readFileSync(join(dir, "kubectl.argv"), "utf8").split("\n").filter(Boolean) : []);
const ctx = { KUBE_CONTEXT: "testctx" };

test("refuses to run without KUBE_CONTEXT: the current context is never assumed", () => {
  const r = run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /set KUBE_CONTEXT/);
  assert.equal(calls().length, 0);
});

test("NAMESPACE must be a Kubernetes name", () => {
  const r = run({ ...ctx, NAMESPACE: "a b" });
  assert.equal(r.status, 1);
  assert.match(r.out, /NAMESPACE must be a Kubernetes name/);
  assert.equal(calls().length, 0);
});

test("passes when the marker survives pod delete, api restart and scale 0 to 1; each event really happens", () => {
  const r = run(ctx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS: the marker survived 3 of 3 events/);
  const c = calls();
  assert.ok(c.every((l) => l.startsWith("--context testctx -n contentcollab ")), c.join("\n"));
  assert.ok(c.some((l) => l.includes("delete pod postgres-0")));
  assert.ok(c.some((l) => l.includes("rollout restart deployment/api")));
  const zero = c.findIndex((l) => l.includes("scale statefulset postgres --replicas=0"));
  const one = c.findIndex((l) => l.includes("scale statefulset postgres --replicas=1"));
  assert.ok(zero >= 0 && one > zero, "scaled to 0 then to 1");
  assert.ok(!c.some((l) => /cordon|drain/.test(l)), "no drain unless asked");
});

for (const [forget, phrase] of [["delete", "after deleting the postgres pod"], ["restart", "after restarting the api"], ["scale", "after scaling postgres to 0 and back to 1"]]) {
  test(`fails when the data is gone ${phrase}`, () => {
    const r = run({ ...ctx, STUB_FORGET: forget });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`FAIL: marker missing ${phrase}`));
  });
}

test("fails when the postgres pod was not replaced, so a pass would prove nothing", () => {
  const r = run({ ...ctx, STUB_SAME_UID: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL: postgres-0 was not replaced/);
});

test("DRAIN=1 needs two nodes and refuses before touching any", () => {
  const r = run({ ...ctx, DRAIN: "1", STUB_NODES: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /DRAIN=1 needs at least two nodes/);
  assert.ok(!calls().some((l) => /cordon|drain|delete pod/.test(l)));
});

test("DRAIN=1 cordons, drains, checks the marker and uncordons, in that order", () => {
  const r = run({ ...ctx, DRAIN: "1" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS: the marker survived 4 of 4 events/);
  const c = calls();
  const at = (word) => c.findIndex((l) => new RegExp(`\\b${word} node-1`).test(l));
  assert.ok(at("cordon") >= 0 && at("drain") > at("cordon") && at("uncordon") > at("drain"), c.join("\n"));
});

test("the node is uncordoned even when the check after the drain fails", () => {
  const r = run({ ...ctx, DRAIN: "1", STUB_FORGET: "drain" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL: marker missing after draining node-1/);
  assert.ok(calls().some((l) => /\buncordon node-1/.test(l)));
});
