// scripts/app-secret.sh against a stand-in kubectl (#53; SEC-1, SEC-10): values stay out of argument
// lists, output and files; an existing Secret keeps what the caller does not give.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sandbox } from "./stub-lib.mjs";

const b64 = (s) => Buffer.from(s).toString("base64");
const STUBS = { kubectl: "kubectl-stub.sh" };

// Made-up values in the shape of the real ones; none is a real key
const SPACES = { SPACES_KEY: "TESTKEY0123456789AB", SPACES_SECRET: "testsecret+/0123456789abcdefghijklmnopqrstuvwxyz" };
let box;
beforeEach(() => (box = sandbox(STUBS)));
afterEach(() => box.cleanup());

const applied = () =>
  Object.fromEntries([...box.file("apply.stdin").matchAll(/^ {2}([A-Z_]+): "(.*)"$/gm)].map((m) => [m[1], m[2]]));
const calls = () => box.file("kubectl.argv").split("\n").filter(Boolean);
const existing = {
  STUB_EXISTS: "1",
  STUB_DATA_DB_USER: b64("olduser"),
  STUB_DATA_DB_PASSWORD: b64("old-db-password-0123456789"),
  STUB_DATA_JWT_SECRET: b64("old-jwt-secret-0123456789abcdefghijklmnop"),
  STUB_DATA_SPACES_KEY: b64("OLDKEY"),
  STUB_DATA_SPACES_SECRET: b64("OLDSECRET"),
};

test("first run: server-side apply over stdin, defaults and generated values, nothing in argv or output", () => {
  const r = box.run("app-secret.sh", { env: SPACES });
  assert.equal(r.status, 0, r.out);
  const values = applied();
  assert.deepEqual(Object.keys(values), ["DB_USER", "DB_PASSWORD", "JWT_SECRET", "SPACES_KEY", "SPACES_SECRET"]);
  assert.equal(values.DB_USER, "contentcollab");
  assert.match(values.DB_PASSWORD, /^[0-9a-f]{48}$/);
  assert.match(values.JWT_SECRET, /^[0-9a-f]{64}$/);
  assert.equal(values.SPACES_KEY, SPACES.SPACES_KEY);
  assert.equal(values.SPACES_SECRET, SPACES.SPACES_SECRET);
  const apply = calls().find((c) => c.includes("apply"));
  assert.match(apply, /apply --server-side --force-conflicts --field-manager=app-secret -f -$/);
  const everywhere = `${box.file("kubectl.argv")}${r.out}`;
  // every value except the 13-character default user name, which is also the namespace
  for (const v of Object.values(values).filter((x) => x.length > 16)) {
    assert.ok(!everywhere.includes(v), "a value leaked into argv or output");
  }
  assert.ok(!calls().some((c) => c.includes("annotate")), "nothing to clean on a new Secret");
});

test("existing Secret: values the caller does not give are kept, the old plain-text annotation is removed", () => {
  const r = box.run("app-secret.sh", { env: { ...existing, ...SPACES } });
  assert.equal(r.status, 0, r.out);
  const values = applied();
  assert.equal(values.DB_USER, "olduser");
  assert.equal(values.DB_PASSWORD, "old-db-password-0123456789");
  assert.equal(values.JWT_SECRET, "old-jwt-secret-0123456789abcdefghijklmnop");
  assert.equal(values.SPACES_KEY, SPACES.SPACES_KEY);
  const removal = /annotate secret app-secrets kubectl\.kubernetes\.io\/last-applied-configuration-$/;
  assert.ok(calls().some((c) => removal.test(c)), calls().join("\n"));
});

test("a value with a quote, a space or a newline is refused before anything is applied", () => {
  for (const bad of ['a"b' + "c".repeat(30), "has space" + "c".repeat(30), "line\nbreak" + "c".repeat(30)]) {
    const r = box.run("app-secret.sh", { env: { ...SPACES, SPACES_SECRET: bad } });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /SPACES_SECRET has characters other than/);
  }
  assert.ok(!calls().some((c) => c.includes("apply")));
});

test("the template placeholder and short passwords are refused", () => {
  let r = box.run("app-secret.sh", { env: { ...SPACES, SPACES_KEY: "REPLACE_ME" } });
  assert.equal(r.status, 1);
  assert.match(r.out, /SPACES_KEY is still the template placeholder/);
  r = box.run("app-secret.sh", { env: { ...SPACES, JWT_SECRET: "short" } });
  assert.equal(r.status, 1);
  assert.match(r.out, /JWT_SECRET must be at least 32 characters/);
  r = box.run("app-secret.sh", { env: { ...SPACES, DB_PASSWORD: "short" } });
  assert.equal(r.status, 1);
  assert.match(r.out, /DB_PASSWORD must be at least 16 characters/);
  assert.ok(!calls().some((c) => c.includes("apply")));
});

test("a read error other than NotFound stops the run: no blind new database password", () => {
  const error = 'Error from server (Forbidden): secrets "app-secrets" is forbidden';
  const r = box.run("app-secret.sh", { env: { ...SPACES, STUB_GET_ERROR: error } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /cannot read app-secrets/);
  assert.ok(!calls().some((c) => c.includes("apply")));
});

test("the namespace must exist: the message names the command that creates it", () => {
  const r = box.run("app-secret.sh", { env: { ...SPACES, STUB_NO_NAMESPACE: "1" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /kubectl apply -f k8s\/base\/namespace\.yaml/);
  assert.ok(!calls().some((c) => c.includes("apply")));
});

test("without Spaces values on a new Secret the keys are applied empty, with a warning", () => {
  const r = box.run("app-secret.sh");
  assert.equal(r.status, 0, r.out);
  assert.equal(applied().SPACES_KEY, "");
  assert.equal(applied().SPACES_SECRET, "");
  assert.match(r.out, /SPACES_KEY is empty: uploads fail until it is set/);
});

test("KUBE_CONTEXT is passed to every kubectl call and the target is printed", () => {
  const r = box.run("app-secret.sh", { env: { ...SPACES, KUBE_CONTEXT: "minikube" } });
  assert.equal(r.status, 0, r.out);
  assert.ok(calls().every((c) => c.startsWith("--context minikube ")), calls().join("\n"));
  assert.match(r.out, /context minikube, namespace contentcollab/);
});

test("RESTART=1 restarts api and worker so they read the new values, only when the Secret existed", () => {
  let r = box.run("app-secret.sh", { env: { ...existing, ...SPACES, RESTART: "1" } });
  assert.equal(r.status, 0, r.out);
  assert.ok(calls().some((c) => c.endsWith("rollout restart deployment/api")));
  assert.ok(calls().some((c) => c.endsWith("rollout restart deployment/worker")));
  box.cleanup();
  box = sandbox(STUBS);
  r = box.run("app-secret.sh", { env: { ...SPACES, RESTART: "1" } });
  assert.equal(r.status, 0, r.out);
  assert.ok(!calls().some((c) => c.includes("rollout restart")), "a first run has nothing to restart");
});

test("the summary says where each key came from and never prints a value", () => {
  const r = box.run("app-secret.sh", { env: { ...existing, SPACES_KEY: SPACES.SPACES_KEY } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /DB_PASSWORD: kept/);
  assert.match(r.out, /SPACES_KEY: from the environment/);
  assert.ok(!r.out.includes(SPACES.SPACES_KEY));
});
