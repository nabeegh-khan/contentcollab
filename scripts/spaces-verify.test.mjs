// scripts/spaces-verify.sh against a stand-in AWS CLI and curl (#53; SEC-2): the key can do what the API
// does with objects (#40: put, multipart, get, copy, delete), the bucket is private, and, when asked, the
// key cannot reach another bucket. Control flow only: the real service is checked by running the script.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./stub-lib.mjs";

const configMap = readFileSync(join(import.meta.dirname, "..", "k8s", "base", "configmap.yaml"), "utf8");
const fromConfig = (key) => configMap.match(new RegExp(`^ {2}${key}:\\s*(\\S+)`, "m"))[1];
const BUCKET = fromConfig("SPACES_BUCKET");
const KEYS = { SPACES_KEY: "TESTKEY0123456789AB", SPACES_SECRET: "testsecret+/0123456789abcdefghijklmnopqrstuvwxyz" };

let box;
beforeEach(() => (box = sandbox({ aws: "aws-stub.sh", curl: "curl-stub.sh" })));
afterEach(() => box.cleanup());
const run = (env = {}) => box.run("spaces-verify.sh", { env: { STUB_BUCKET: BUCKET, ...KEYS, ...env } });
const awsCalls = () => box.file("aws.argv").split("\n").filter(Boolean);

test("passes when every step works; settings come from the ConfigMap; the key travels in the environment", () => {
  const r = run();
  assert.equal(r.status, 0, r.out);
  for (const step of ["bucket reachable", "small object round trip", "multipart upload round trip", "server-side copy", "anonymous read refused", "probe objects deleted"]) {
    assert.match(r.stdout, new RegExp(`ok +${step}`), r.stdout);
  }
  assert.ok(awsCalls().every((c) => c.startsWith(`--endpoint-url ${fromConfig("SPACES_ENDPOINT")} --region ${fromConfig("SPACES_REGION")} `)));
  assert.equal(box.file("aws.env").trim(), `${KEYS.SPACES_KEY}:${KEYS.SPACES_SECRET}`);
  assert.ok(!box.file("aws.argv").includes(KEYS.SPACES_SECRET) && !r.out.includes(KEYS.SPACES_SECRET), "the secret half appeared in an argument or in output");
});

test("the large upload is bigger than the AWS CLI multipart threshold (8 MiB), so it goes in parts", () => {
  run();
  const big = box.file("aws.sizes").split("\n").find((l) => l.includes("big.bin"));
  assert.ok(Number(big.split(" ")[1]) > 8 * 1024 * 1024, big);
});

test("the anonymous read goes to the path-style address of the probe object and must be refused", () => {
  run();
  const url = box.file("curl.argv").trim().split(" ").at(-1);
  assert.match(url, new RegExp(`^${fromConfig("SPACES_ENDPOINT")}/${BUCKET}/probe/[0-9]+-[0-9]+/small\\.txt$`));
  const r = run({ STUB_ANON_CODE: "200" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL +anonymous read refused/);
});

test("a failing step is reported, the run exits 1, and the probe objects are still deleted", () => {
  const r = run({ STUB_FAIL: "copy-object" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stdout, /FAIL +server-side copy/);
  assert.match(r.stdout, /ok +small object round trip/, "later steps still run");
  assert.ok(awsCalls().filter((c) => c.includes("delete-object")).length >= 2);
});

test("a download that differs from the upload fails the round trip", () => {
  const r = run({ STUB_CORRUPT: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL +small object round trip/);
});

test("a server-side copy whose bytes differ from the source fails its own step only", () => {
  const r = run({ STUB_CORRUPT_COPY: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL +server-side copy/);
  assert.match(r.stdout, /ok +small object round trip/);
});

test("FOREIGN_BUCKET: the key must be refused there; success means the key is too wide", () => {
  let r = run({ FOREIGN_BUCKET: "some-other-bucket" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /ok +key refused on some-other-bucket/);
  box.cleanup();
  box = sandbox({ aws: "aws-stub.sh", curl: "curl-stub.sh" });
  r = run({ FOREIGN_BUCKET: "some-other-bucket", STUB_FOREIGN_OK: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL +key refused on some-other-bucket/);
  assert.ok(awsCalls().some((c) => c.includes("delete-object --bucket some-other-bucket")), "the stray object is removed");
});

test("FOREIGN_BUCKET that does not exist proves nothing and fails", () => {
  const r = run({ FOREIGN_BUCKET: "no-such-bucket-here", STUB_FOREIGN_MISSING: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL +key refused on no-such-bucket-here/);
  assert.match(r.stdout, /does not exist/);
});

test("a large file that comes back different fails the multipart step only", () => {
  const r = run({ STUB_CORRUPT_BIG: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL +multipart upload round trip/);
  assert.match(r.stdout, /ok +small object round trip/);
});

test("an object still there after delete fails the delete step", () => {
  const r = run({ STUB_KEEP_AFTER_DELETE: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL +probe objects deleted/);
});

test("an unreachable bucket stops the run before any upload", () => {
  const r = run({ STUB_BUCKET: "some-other-name" });
  assert.equal(r.status, 1);
  assert.match(r.out, /cannot continue/);
  assert.ok(!awsCalls().some((c) => c.includes("put-object")));
});

test("a plain http endpoint is refused unless it is loopback", () => {
  const refused = run({ SPACES_ENDPOINT: "http://example.com" });
  assert.equal(refused.status, 1);
  assert.match(refused.out, /SPACES_ENDPOINT must be https/);
  assert.equal(awsCalls().length, 0);
  const local = run({ SPACES_ENDPOINT: "http://127.0.0.1:19000" });
  assert.equal(local.status, 0, local.out);
});

test("objects the cleanup could not delete are named, not hidden", () => {
  const r = run({ STUB_FAIL: "delete-object" });
  assert.equal(r.status, 1);
  assert.match(r.out, /left behind in the bucket: probe\/[0-9]+-[0-9]+\/small\.txt/);
});

test("without FOREIGN_BUCKET the scope check is skipped, and said so", () => {
  const r = run();
  assert.match(r.stdout, /skip +key scope/);
});

test("without SPACES_KEY and SPACES_SECRET and no terminal it stops before any call", () => {
  const r = box.run("spaces-verify.sh", { env: { STUB_BUCKET: BUCKET } });
  assert.equal(r.status, 1);
  assert.match(r.out, /set SPACES_KEY and SPACES_SECRET/);
  assert.equal(awsCalls().length, 0);
});
