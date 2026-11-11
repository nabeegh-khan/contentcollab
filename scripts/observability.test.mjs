// Tests for observability-up.sh and observability-down.sh (#109, ARCHITECTURE D19).
// kubectl and doctl are replaced by a stub on PATH that records its arguments,
// and KUBECONFIG points at a file that does not exist, so no test can reach
// the real cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const UP = join(here, "observability-up.sh");
const DOWN = join(here, "observability-down.sh");

// The stub answers the few kubectl calls the scripts make and logs every call
const STUB = `#!/usr/bin/env bash
echo "kubectl $*" >> "$STUB_LOG"
case "$*" in
  "config current-context") echo "$STUB_CONTEXT" ;;
  "get nodes --no-headers") printf '%b' "$STUB_NODES" ;;
  "-n observability get secret grafana-admin"*) [ "$STUB_SECRET" = 1 ] || exit 1 ;;
  *) : ;;
esac
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "obs-test-"));
  writeFileSync(join(dir, "kubectl"), STUB);
  chmodSync(join(dir, "kubectl"), 0o755);
  return dir;
}

function run(script, env, dir = setup()) {
  const log = join(dir, "calls.log");
  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      KUBECONFIG: join(dir, "no-such-kubeconfig"),
      STUB_LOG: log,
      STUB_CONTEXT: "do-nyc3-contentcollab",
      STUB_NODES: "node-a   Ready   <none>   1h   v1.37.0\\nnode-b   Ready   <none>   5m   v1.37.0\\n",
      STUB_SECRET: "0",
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...r, calls, out: r.stdout + r.stderr };
}

const applied = (calls) => calls.some((c) => /^kubectl apply -k .*k8s\/observability/.test(c));

test("up: refuses a context other than the expected cluster, before any change", () => {
  const r = run(UP, { STUB_CONTEXT: "minikube" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /minikube/);
  assert.ok(!applied(r.calls), "nothing applied");
  assert.ok(!r.calls.some((c) => /create secret/.test(c)), "no secret created");
});

test("up: with one ready node it prints the node-pool command and stops", () => {
  const r = run(UP, { STUB_NODES: "node-a   Ready   <none>   1h   v1.37.0\\n" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /doctl kubernetes cluster node-pool update contentcollab default .*--min-nodes 2/);
  assert.ok(!applied(r.calls), "nothing applied");
});

test("up: a NotReady node is not counted", () => {
  const r = run(UP, {
    STUB_NODES: "node-a   Ready   <none>   1h   v1.37.0\\nnode-b   NotReady   <none>   1m   v1.37.0\\n",
  });
  assert.equal(r.status, 1, r.out);
  assert.ok(!applied(r.calls));
});

test("up: ALLOW_ONE_NODE=1 proceeds on one node and says so", () => {
  const r = run(UP, { STUB_NODES: "node-a   Ready   <none>   1h   v1.37.0\\n", ALLOW_ONE_NODE: "1" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /one node/i);
  assert.ok(applied(r.calls));
});

test("up: on two nodes creates the Grafana password once, applies, waits for each rollout", () => {
  const r = run(UP, {});
  assert.equal(r.status, 0, r.out);
  const createAt = r.calls.findIndex((c) => /create secret generic grafana-admin/.test(c));
  const applyAt = r.calls.findIndex((c) => /^kubectl apply -k/.test(c));
  assert.ok(createAt >= 0, "secret created");
  assert.ok(applyAt >= 0, "applied");
  for (const d of ["prometheus", "kube-state-metrics", "grafana"]) {
    assert.ok(r.calls.some((c) => c.includes(`rollout status deploy/${d}`)), `waits for ${d}`);
  }
  // The password is never printed
  const secretCall = r.calls[createAt];
  const pw = /--from-literal=admin-password=(\S+)/.exec(secretCall)?.[1];
  assert.ok(pw && pw.length >= 24, "random password of 24+ characters");
  assert.ok(!r.out.includes(pw), "password not in the output");
});

test("up: keeps an existing Grafana password", () => {
  const r = run(UP, { STUB_SECRET: "1" });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.calls.some((c) => /create secret generic grafana-admin/.test(c)));
});

test("up: DRY_RUN=1 changes nothing", () => {
  const r = run(UP, { DRY_RUN: "1" });
  assert.equal(r.status, 0, r.out);
  assert.ok(!applied(r.calls));
  assert.ok(!r.calls.some((c) => /create (namespace|secret)/.test(c)));
  assert.match(r.out, /would/i);
});

test("down: refuses the wrong context", () => {
  const r = run(DOWN, { STUB_CONTEXT: "minikube" });
  assert.equal(r.status, 1, r.out);
  assert.ok(!r.calls.some((c) => /delete/.test(c)));
});

test("down: deletes the stack and prints how to return the pool to one node", () => {
  const r = run(DOWN, {});
  assert.equal(r.status, 0, r.out);
  assert.ok(r.calls.some((c) => /^kubectl delete -k .*k8s\/observability --ignore-not-found/.test(c)), r.calls.join("\n"));
  assert.match(r.out, /doctl kubernetes cluster node-pool update contentcollab default .*--min-nodes 1/);
});
