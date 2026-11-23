// The scripts that act on kubectl's current context stop when it is not the one the caller named (#106, D32, INF-20).
// A stand-in kubectl reports another context; nothing reaches a cluster.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sandbox } from "./stub-lib.mjs";
import { checkKubeContext } from "./kube-context-lib.mjs";

const stubs = {
  kubectl: "context-kubectl-stub.sh",
  helm: "context-helm-stub.sh",
  doctl: "context-doctl-stub.sh",
  git: "context-git-stub.sh",
};
let sb;
const setup = () => (sb = sandbox(stubs));
afterEach(() => sb?.cleanup());
const calls = (tool) => sb.file(`${tool}.argv`).split("\n").filter(Boolean);
const otherKubectl = () => calls("kubectl").filter((l) => !l.includes("config current-context"));
const WANT = "do-nyc3-contentcollab";
// Node starts kubectl without a shell, so on Windows it finds the real kubectl.exe and not the bash stand-in: these run in CI (Linux)
const needsLinux = { skip: process.platform === "win32" && "node cannot run the bash stand-in kubectl on Windows" };

// --- the pure comparison
test("checkKubeContext: a match passes, a difference or a missing name for a writer stops", () => {
  assert.equal(checkKubeContext({ expected: WANT, current: WANT, writes: true }).ok, true);
  const bad = checkKubeContext({ expected: WANT, current: "minikube", writes: false });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /minikube/);
  assert.match(bad.message, new RegExp(WANT));
  assert.match(bad.message, /use-context/);
  const none = checkKubeContext({ expected: "", current: "minikube", writes: true });
  assert.equal(none.ok, false);
  assert.match(none.message, /set KUBE_CONTEXT/);
  const noCurrent = checkKubeContext({ expected: WANT, current: "", writes: false });
  assert.equal(noCurrent.ok, false);
});

test("checkKubeContext: a reader without a name carries on and says which context it uses", () => {
  const r = checkKubeContext({ expected: "", current: "minikube", writes: false });
  assert.equal(r.ok, true);
  assert.match(r.message, /minikube/);
  assert.match(r.message, /KUBE_CONTEXT/);
  const nothing = checkKubeContext({ expected: "", current: "", writes: false });
  assert.equal(nothing.ok, true);
  assert.equal(nothing.message, "");
});

// --- metrics-server.sh
test("metrics-server.sh without KUBE_CONTEXT stops before helm", () => {
  setup();
  const r = sb.run("metrics-server.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /set KUBE_CONTEXT/);
  assert.equal(calls("helm").length, 0);
  assert.deepEqual(otherKubectl(), []);
});

test("metrics-server.sh on another context stops before helm and names both", () => {
  setup();
  const r = sb.run("metrics-server.sh", { env: { KUBE_CONTEXT: WANT, STUB_CONTEXT: "minikube" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /current context is "minikube", not "do-nyc3-contentcollab"/);
  assert.equal(calls("helm").length, 0);
  assert.deepEqual(otherKubectl(), []);
});

test("metrics-server.sh with no current context stops before helm", () => {
  setup();
  const r = sb.run("metrics-server.sh", { env: { KUBE_CONTEXT: WANT, STUB_NO_CONTEXT: "1" } });
  assert.equal(r.status, 1, r.out);
  assert.equal(calls("helm").length, 0);
});

test("metrics-server.sh on the named context installs", needsLinux, () => {
  setup();
  const r = sb.run("metrics-server.sh", { env: { KUBE_CONTEXT: WANT, STUB_CONTEXT: WANT } });
  assert.equal(r.status, 0, r.out);
  assert.ok(calls("helm").some((l) => l.startsWith("upgrade --install metrics-server")), calls("helm").join("\n"));
});

// --- cluster-up.sh: the context doctl selected must be the named cluster before anything is applied
const up = { LETSENCRYPT_EMAIL: "a@b.c", SECRETS_FILE: "scripts/README.md", IMAGE_TAG: "not-a-sha" };

test("cluster-up.sh stops when doctl left another context selected, before any kubectl call", () => {
  setup();
  const r = sb.run("cluster-up.sh", { env: { ...up, STUB_CONTEXT: "minikube" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /minikube/);
  assert.match(r.out, new RegExp(WANT));
  assert.deepEqual(otherKubectl(), []);
  assert.equal(calls("helm").length, 0);
});

test("cluster-up.sh goes on when the context is do-<region>-<cluster>", () => {
  setup();
  const r = sb.run("cluster-up.sh", { env: { ...up, STUB_CONTEXT: WANT } });
  assert.match(r.out, /not a full commit SHA/); // stopped later, by the image-tag check
  assert.ok(otherKubectl().some((l) => l.startsWith("get nodes")), calls("kubectl").join("\n"));
});

test("cluster-up.sh accepts a KUBE_CONTEXT that is the current context", () => {
  setup();
  const r = sb.run("cluster-up.sh", { env: { ...up, KUBE_CONTEXT: "my-alias", STUB_CONTEXT: "my-alias" } });
  assert.match(r.out, /not a full commit SHA/);
});

test("cluster-up.sh honours KUBE_CONTEXT as the expected name", () => {
  setup();
  const r = sb.run("cluster-up.sh", { env: { ...up, KUBE_CONTEXT: "my-alias", STUB_CONTEXT: WANT } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /my-alias/);
  assert.deepEqual(otherKubectl(), []);
});

// --- hpa-ready.mjs (reads only)
test("hpa-ready.mjs on another context than KUBE_CONTEXT stops before reading the HPA", needsLinux, () => {
  setup();
  const r = sb.runNode("hpa-ready.mjs", { env: { KUBE_CONTEXT: WANT, STUB_CONTEXT: "minikube" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /minikube/);
  assert.deepEqual(otherKubectl(), []);
});

test("hpa-ready.mjs on the named context reads the HPA", needsLinux, () => {
  setup();
  const r = sb.runNode("hpa-ready.mjs", { env: { KUBE_CONTEXT: WANT, STUB_CONTEXT: WANT } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /reading cpu/);
});

test("hpa-ready.mjs without KUBE_CONTEXT reads, and says which context it used", needsLinux, () => {
  setup();
  const r = sb.runNode("hpa-ready.mjs", { env: { STUB_CONTEXT: "minikube" } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /kubectl context: minikube/);
});

// --- loadtest.mjs: BASE points at a closed port, so a run that got past the check would show it
const load = { BASE: "http://127.0.0.1:9", STEPS: "1", STEP_SECONDS: "1", SKIP_HPA_CHECK: "1" };

test("loadtest.mjs on another context than KUBE_CONTEXT stops before any load", needsLinux, () => {
  setup();
  const r = sb.runNode("loadtest.mjs", { env: { ...load, KUBE_CONTEXT: WANT, STUB_CONTEXT: "minikube" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /minikube/);
  assert.doesNotMatch(r.out, /Target http/);
  assert.deepEqual(otherKubectl(), []);
});

test("loadtest.mjs with ROLLOUT=1 and no KUBE_CONTEXT stops before the restart", needsLinux, () => {
  setup();
  const r = sb.runNode("loadtest.mjs", { env: { ...load, ROLLOUT: "1", STUB_CONTEXT: "minikube" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /set KUBE_CONTEXT/);
  assert.doesNotMatch(r.out, /Target http/);
  assert.ok(!otherKubectl().some((l) => l.includes("rollout")), calls("kubectl").join("\n"));
});
