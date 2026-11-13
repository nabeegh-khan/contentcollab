// scripts/pv-retain.sh against a stand-in kubectl (#104; INF-14, DB-12): the PostgreSQL volume's
// PersistentVolume is set to Retain, so deleting the claim or the namespace no longer deletes the data.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const SCRUBBED = /^(KUBECONFIG|KUBE_CONTEXT|NAMESPACE|STUB_.*)$/;
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pvretain-"));
  mkdirSync(join(dir, "bin"));
  const body = readFileSync(join(root, "scripts", "testdata", "pv-retain-kubectl-stub.sh"), "utf8").replaceAll("\r\n", "\n");
  writeFileSync(join(dir, "bin", "kubectl"), `#!/usr/bin/env bash\n${body}`);
  chmodSync(join(dir, "bin", "kubectl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Refuses to run unless kubectl resolves to the stand-in; KUBECONFIG points nowhere
function run(env = {}) {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUBBED.test(k)));
  const full = { ...base, [pathKey]: `${join(dir, "bin")}${delimiter}${process.env[pathKey]}`, KUBECONFIG: join(dir, "none"), STUB_DIR: dir, ...env };
  const found = spawnSync("bash", ["-c", "command -v kubectl"], { env: full, encoding: "utf8" }).stdout.trim();
  if (!found.includes(basename(dir))) throw new Error(`kubectl resolves to '${found}', not the stub: refusing to run`);
  const r = spawnSync("bash", ["scripts/pv-retain.sh"], { cwd: root, env: full, encoding: "utf8", timeout: 30_000 });
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

test("patches the claim's PersistentVolume from Delete to Retain and shows both", () => {
  const r = run(ctx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /pvc-123: Delete -> Retain/);
  const c = calls();
  assert.ok(c.every((l) => l.startsWith("--context testctx ")), c.join("\n"));
  const patch = c.filter((l) => l.includes("patch pv pvc-123"));
  assert.equal(patch.length, 1);
  assert.match(patch[0], /"persistentVolumeReclaimPolicy":"Retain"/);
});

test("leaves a volume that is already Retain alone", () => {
  const r = run({ ...ctx, STUB_POLICY: "Retain" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /pvc-123 is already Retain/);
  assert.ok(!calls().some((l) => l.includes("patch")));
});

test("fails when there is no claim to protect", () => {
  const r = run({ ...ctx, STUB_NO_CLAIM: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no claim data-postgres-0/);
  assert.ok(!calls().some((l) => l.includes("patch")));
});

test("fails when the policy reads back as anything but Retain after the patch", () => {
  const r = run({ ...ctx, STUB_PATCH_NOOP: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL: pvc-123 is still Delete/);
});
