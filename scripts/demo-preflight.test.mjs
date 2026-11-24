// scripts/demo-preflight.sh against stand-ins for kubectl and curl (#174, D34; TST-3): each check fails with its own one-line reason, missing demo data is seeded through the API, and no secret reaches an argument or the output.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sandbox } from "./stub-lib.mjs";

let sb;
beforeEach(() => {
  sb = sandbox({ kubectl: "preflight-kubectl-stub.sh", curl: "preflight-curl-stub.sh" });
});
afterEach(() => sb.cleanup());

const PW = { DEMO_ADMIN_PASSWORD: "pw-admin-1", DEMO_REVIEWER_PASSWORD: "pw-reviewer-1" };
const good = { KUBE_CONTEXT: "testctx", ...PW };
const run = (env = {}) => sb.run("demo-preflight.sh", { env: { ...good, ...env } });
const lines = (file) => sb.file(file).split("\n").filter(Boolean);
const requests = () => lines("curl.requests");
const failLines = (r) => r.stdout.split("\n").filter((l) => l.startsWith("FAIL:"));

test("refuses to run without KUBE_CONTEXT: the current context is never assumed", () => {
  const r = sb.run("demo-preflight.sh", { env: PW });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /KUBE_CONTEXT/);
  assert.equal(lines("kubectl.argv").length, 0);
});

test("everything in place: passes, changes nothing, every kubectl call names the context", () => {
  const r = run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /preflight passed/);
  assert.equal(failLines(r).length, 0, r.out);
  const changes = requests().filter((l) => /^(POST|DELETE|PATCH|PUT) /.test(l) && !l.includes("/auth/login"));
  assert.deepEqual(changes, [], changes.join("\n"));
  const k = lines("kubectl.argv");
  assert.ok(k.length > 0);
  assert.ok(k.every((l) => l.startsWith("--context testctx ")), k.join("\n"));
});

test("a pod that is not Ready stops it with that pod's name", () => {
  const r = run({ STUB_POD_NOT_READY: "web-7fd78bcf9d-hfblz" });
  assert.equal(r.status, 1, r.out);
  assert.equal(failLines(r).length, 1, r.out);
  assert.match(failLines(r)[0], /web-7fd78bcf9d-hfblz.*not Ready/);
});

test("a missing component stops it with the component's name", () => {
  const r = run({ STUB_NO_POD: "worker" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /no worker pod/);
});

test("a Completed job pod is not a failure", () => {
  const r = run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /ignored 1 finished job pod/);
});

test("no autoscaler for the api stops it", () => {
  const r = run({ STUB_NO_HPA: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /autoscaler/);
});

test("the Gateway answering anything but 200 stops it with the code", () => {
  const r = run({ STUB_GATEWAY_CODE: "503" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /503/);
});

test("a plain http address is refused: the demo is HTTPS", () => {
  const r = run({ BASE: "http://contentcollab.app" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /https/);
  assert.equal(requests().length, 0);
});

test("Redis down in /health stops it naming Redis", () => {
  const r = run({ STUB_REDIS_DOWN: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /redis/i);
});

test("PostgreSQL down in /health stops it naming PostgreSQL", () => {
  const r = run({ STUB_PG_DOWN: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /postgres/i);
});

test("no demo password set stops it naming the variable, before any sign-in", () => {
  const r = run({ DEMO_REVIEWER_PASSWORD: "" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /DEMO_REVIEWER_PASSWORD/);
  assert.ok(!requests().some((l) => l.includes("/auth/login")));
});

test("a missing account is registered, then signs in", () => {
  const r = run({ STUB_NO_REVIEWER: "1" });
  assert.equal(r.status, 0, r.out);
  const reg = requests().filter((l) => l.includes("POST") && l.includes("/auth/register"));
  assert.equal(reg.length, 1, requests().join("\n"));
  assert.match(sb.file("curl.bodies"), /"email":"reviewer@contentcollab.app"/);
  assert.match(r.stdout, /registered reviewer@contentcollab.app/);
});

test("an account that exists with another password stops it, and nothing is overwritten", () => {
  const r = run({ DEMO_ADMIN_PASSWORD: "not-the-password" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /admin@contentcollab.app.*password/);
});

test("the admin refused by /ops names OPS_ADMIN_USER_IDS", () => {
  const r = run({ STUB_ADMIN_NOT_OPS: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /OPS_ADMIN_USER_IDS/);
});

test("the reviewer allowed into /ops stops it: the demo shows a refusal", () => {
  const r = run({ STUB_REVIEWER_OPS: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /reviewer.*\/ops/);
});

test("a missing 'Demo document' is uploaded as the admin and its address printed", () => {
  const r = run({ STUB_NO_DEMO: "1" });
  assert.equal(r.status, 0, r.out);
  const up = requests().filter((l) => l.startsWith("POST ") && l.endsWith("/documents"));
  assert.equal(up.length, 1, requests().join("\n"));
  assert.match(sb.file("curl.argv"), /title=Demo document/);
  assert.match(r.stdout, /uploaded "Demo document"/);
  assert.match(r.stdout, /#\/documents\/doc-new-1\/versions\/ver-new-1/);
});

test("a missing 'Design review draft' is uploaded and left unshared", () => {
  const r = run({ STUB_NO_DRAFT: "1" });
  assert.equal(r.status, 0, r.out);
  assert.match(sb.file("curl.argv"), /title=Design review draft/);
  assert.match(r.stdout, /uploaded "Design review draft"/);
  assert.ok(!requests().some((l) => l.startsWith("POST ") && l.includes("/shares")), "the script never shares the draft");
});

test("a share left on the draft is deleted so the reviewer cannot see it", () => {
  const r = run({ STUB_DRAFT_SHARED: "1" });
  assert.equal(r.status, 0, r.out);
  const del = requests().filter((l) => l.startsWith("DELETE ") && l.includes("/documents/doc-draft/shares/share-1"));
  assert.equal(del.length, 1, requests().join("\n"));
  assert.match(r.stdout, /removed the reviewer's share/);
});

test("a draft whose file will not download stops it naming Spaces", () => {
  const r = run({ STUB_CONTENT_CODE: "500" });
  assert.equal(r.status, 1, r.out);
  assert.match(failLines(r)[0], /Spaces/);
});

test("no password or token appears in a curl argument or in the output", () => {
  const r = run({ STUB_NO_DRAFT: "1" });
  assert.equal(r.status, 0, r.out);
  const argv = sb.file("curl.argv");
  for (const secret of ["pw-admin-1", "pw-reviewer-1", "tok-admin", "tok-reviewer"]) {
    assert.ok(!argv.includes(secret), `${secret} in a curl argument`);
    assert.ok(!r.out.includes(secret), `${secret} in the output`);
  }
  assert.match(sb.file("curl.bodies"), /pw-admin-1/, "the sign-in body does reach curl, on standard input");
});

test("on failure there is exactly one FAIL line and nothing after it", () => {
  const r = run({ STUB_NO_HPA: "1" });
  assert.equal(r.status, 1, r.out);
  assert.equal(failLines(r).length, 1);
  const last = r.stdout.trimEnd().split("\n").pop();
  assert.ok(last.startsWith("FAIL:"), last);
});
