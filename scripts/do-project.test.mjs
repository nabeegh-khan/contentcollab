// scripts/do-project.sh against a stand-in doctl (#53; INF-3): finds the project by its exact name or
// creates it once, and stops early on a missing authentication or a bad value.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sandbox } from "./stub-lib.mjs";

const ID = "11111111-2222-3333-4444-555555555555";
let box;
beforeEach(() => (box = sandbox({ doctl: "doctl-stub.sh" })));
afterEach(() => box.cleanup());
const calls = () => box.file("doctl.argv").split("\n").filter(Boolean);

test("creates the project once, with the documented flags, and prints its id", () => {
  const r = box.run("do-project.sh");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(calls().filter((c) => c.startsWith("projects create")), [
    'projects create --name ContentCollab --purpose Web Application --environment Development --description ECE1779 Team 22: ContentCollab cluster, load balancer and Spaces bucket --format ID --no-header',
  ]);
  assert.match(r.stdout, new RegExp(`ContentCollab: ${ID}`));
});

test("an existing project is reused: no create", () => {
  const r = box.run("do-project.sh", { env: { STUB_PROJECTS: "aaaa-1111  Playground\nbbbb-2222  ContentCollab\n" } });
  assert.equal(r.status, 0, r.out);
  assert.ok(!calls().some((c) => c.startsWith("projects create")));
  assert.match(r.stdout, /ContentCollab: bbbb-2222/);
});

test("a project whose name only starts with ours does not count", () => {
  const r = box.run("do-project.sh", { env: { STUB_PROJECTS: "cccc-3333  ContentCollab-old\n" } });
  assert.equal(r.status, 0, r.out);
  assert.equal(calls().filter((c) => c.startsWith("projects create")).length, 1);
});

test("a project named like ours plus more words is not ours", () => {
  const r = box.run("do-project.sh", { env: { STUB_PROJECTS: "dddd-4444  ContentCollab Old\n" } });
  assert.equal(r.status, 0, r.out);
  assert.equal(calls().filter((c) => c.startsWith("projects create")).length, 1);
});

test("two projects with the same name give one id, not two lines", () => {
  const r = box.run("do-project.sh", { env: { STUB_PROJECTS: "aaaa-1111  ContentCollab\nbbbb-2222  ContentCollab\n" } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^ContentCollab: aaaa-1111$/m);
});

test("stops before any change when doctl is not authenticated", () => {
  const r = box.run("do-project.sh", { env: { STUB_UNAUTH: "1" } });
  assert.equal(r.status, 1);
  assert.match(r.out, /doctl is not authenticated: run `doctl auth init`/);
  assert.ok(!calls().some((c) => c.startsWith("projects")));
});

test("an environment other than the three DigitalOcean lists, or a name with a space, is refused", () => {
  let r = box.run("do-project.sh", { env: { ENVIRONMENT: "Prod" } });
  assert.equal(r.status, 1);
  assert.match(r.out, /ENVIRONMENT must be Development, Staging or Production/);
  r = box.run("do-project.sh", { env: { PROJECT_NAME: "Content Collab" } });
  assert.equal(r.status, 1);
  assert.match(r.out, /PROJECT_NAME may contain letters, digits and dashes only/);
  assert.equal(calls().length, 0, "no doctl call before the values are checked");
});
