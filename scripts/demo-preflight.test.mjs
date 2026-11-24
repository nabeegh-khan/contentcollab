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

// Verifier findings (E1 to E3, S1 to S3): every failure, wherever it happens, ends in exactly one FAIL line
const oneFail = (r, pattern) => {
  assert.equal(r.status, 1, r.out);
  assert.equal(failLines(r).length, 1, r.out);
  assert.ok(r.stdout.trimEnd().split("\n").pop().startsWith("FAIL:"), r.out);
  if (pattern) assert.match(failLines(r)[0], pattern);
};

test("the document list answering 500 ends in one FAIL line, not a silent exit", () => {
  oneFail(run({ STUB_DOCS_CODE: "500" }), /listing documents answered 500/);
});

test("a 200 that is not JSON ends in one FAIL line", () => {
  oneFail(run({ STUB_LOGIN_HTML: "1" }), /unexpected reply/);
});

test("a sign-in reply without a token is not taken as signed in", () => {
  oneFail(run({ STUB_LOGIN_NO_TOKEN: "1" }), /no token/);
});

test("a multi-line /health body still gives one FAIL line, naming only the part that is down", () => {
  const r = run({ STUB_REDIS_DOWN: "1", STUB_HEALTH_MULTILINE: "1" });
  oneFail(r, /redis/i);
  assert.doesNotMatch(failLines(r)[0], /postgres/i);
});

test("PostgreSQL down names PostgreSQL and not Redis", () => {
  const r = run({ STUB_PG_DOWN: "1" });
  oneFail(r, /postgres/i);
  assert.doesNotMatch(failLines(r)[0], /redis/i);
});

test("a Failed pod (an evicted api pod, say) stops it: only finished Jobs are ignored", () => {
  oneFail(run({ STUB_FAILED_POD: "1" }), /api-evicted.*not Ready/);
});

test("two documents with the same title stop it rather than picking one", () => {
  oneFail(run({ STUB_DUP_DEMO: "1" }), /more than one document titled "Demo document"/);
});

test("lists ask for up to 100 rows, since the default page is 20", () => {
  run();
  assert.ok(requests().filter((l) => l.includes("/documents?")).every((l) => l.includes("limit=100")), requests().join("\n"));
});

test("a reviewer-owned document with the draft's title is not mistaken for the share", () => {
  const r = run({ STUB_REVIEWER_OWN_DRAFT: "1" });
  assert.equal(r.status, 0, r.out);
  assert.ok(!requests().some((l) => l.startsWith("DELETE ")), requests().join("\n"));
});

test("a failed share removal ends in one FAIL line", () => {
  oneFail(run({ STUB_DRAFT_SHARED: "1", STUB_DELETE_CODE: "500" }), /removing the reviewer's share answered 500/);
});

test("a registration that answers something unexpected ends in one FAIL line", () => {
  oneFail(run({ STUB_NO_REVIEWER: "1", STUB_REGISTER_CODE: "500" }), /registering reviewer@contentcollab.app answered 500/);
});

test("an unreachable site ends in one FAIL line", () => {
  oneFail(run({ STUB_CURL_FAIL: "1" }), /could not reach/);
});

test("a missing admin password is named too", () => {
  oneFail(run({ DEMO_ADMIN_PASSWORD: "" }), /DEMO_ADMIN_PASSWORD/);
});
