// Tests for memory-headroom.mjs: how much memory the nodes have left for monitoring (#55, ARCHITECTURE D18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { headroom, parseMemory } from "./memory-headroom.mjs";

test("parses Kubernetes memory quantities into MiB", () => {
  assert.equal(parseMemory("1499736Ki"), 1499736 / 1024);
  assert.equal(parseMemory("974Mi"), 974);
  assert.equal(parseMemory("2Gi"), 2048);
  assert.equal(parseMemory("1048576"), 1);
  assert.equal(parseMemory(undefined), 0);
});

// The cluster on 11 Nov 2026, 18:37 UTC (ARCHITECTURE D18): two nodes of 1,499,736 KiB, 974 and 1,166 MiB requested,
// two API pods of 128 MiB (138 MiB in use each), HPA maximum 5
const node = (name) => ({ metadata: { name }, status: { allocatable: { memory: "1499736Ki" } } });
const pod = (name, nodeName, mem, labels = {}) => ({
  metadata: { name, namespace: "x", labels },
  spec: { nodeName, containers: [{ name: "c", resources: { requests: { memory: mem } } }] },
  status: { phase: "Running" },
});
const nodes = { items: [node("a"), node("b")] };
const pods = {
  items: [
    pod("other-a", "a", "846Mi"),
    pod("api-1", "a", "128Mi", { app: "api" }),
    pod("other-b", "b", "1038Mi"),
    pod("api-2", "b", "128Mi", { app: "api" }),
    { ...pod("done", "a", "500Mi"), status: { phase: "Succeeded" } },
  ],
};
const topNodes = "a   209m   11%   1217Mi   83%\nb   227m   11%   1126Mi   76%\n";
const topApi = "api-1   10m   138Mi\napi-2   10m   138Mi\n";
const hpa = { spec: { maxReplicas: 5 }, status: { currentReplicas: 2 } };

test("per node: allocatable, requested, in use, and what is left of each", () => {
  const { nodes: rows } = headroom({ nodes, pods, topNodes, topApi, hpa });
  const [a, b] = rows;
  assert.deepEqual(
    [a.name, a.requestedMi, a.usedMi, Math.round(a.freeRequestedMi * 10) / 10, Math.round(a.freeUsedMi * 10) / 10],
    ["a", 974, 1217, 490.6, 247.6],
  );
  assert.deepEqual(
    [b.name, b.requestedMi, b.usedMi, Math.round(b.freeRequestedMi * 10) / 10, Math.round(b.freeUsedMi * 10) / 10],
    ["b", 1166, 1126, 298.6, 338.6],
  );
});

test("a pod that has finished does not count as requested memory", () => {
  const { nodes: rows } = headroom({ nodes, pods, topNodes, topApi, hpa });
  assert.equal(rows[0].requestedMi, 974);
});

test("with the API at its maximum: 405 MiB unrequested and 172 MiB not in use, as measured", () => {
  const { total, atMax } = headroom({ nodes, pods, topNodes, topApi, hpa });
  assert.equal(Math.round(total.freeRequestedMi * 10) / 10, 789.2);
  assert.equal(atMax.extraPods, 3);
  assert.equal(Math.round(atMax.freeRequestedMi * 10) / 10, 405.2);
  assert.equal(Math.round(atMax.freeUsedMi * 10) / 10, 172.2);
});

test("an HPA already at its maximum adds nothing", () => {
  const full = { spec: { maxReplicas: 2 }, status: { currentReplicas: 2 } };
  const { total, atMax } = headroom({ nodes, pods, topNodes, topApi, hpa: full });
  assert.equal(atMax.extraPods, 0);
  assert.equal(atMax.freeRequestedMi, total.freeRequestedMi);
});

test("says whether an agent of a given size fits at the API maximum", () => {
  const result = headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: 768 });
  assert.equal(result.fits.requests, false);
  assert.equal(result.fits.inUse, false);
  assert.equal(headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: 100 }).fits.requests, true);
});

test("parses decimal and exponent quantities too, and refuses what it cannot read instead of counting 0", () => {
  assert.equal(parseMemory("256M"), (256 * 1000 * 1000) / (1024 * 1024));
  assert.equal(parseMemory("1G"), (1000 * 1000 * 1000) / (1024 * 1024));
  assert.equal(parseMemory("1Ti"), 1024 * 1024);
  assert.equal(parseMemory("129e6"), 129e6 / (1024 * 1024));
  assert.throws(() => parseMemory("100m"), /memory quantity/);
  assert.throws(() => parseMemory("lots"), /memory quantity/);
});

test("sums the requests of every container in a pod, and ignores a pod that failed", () => {
  const two = {
    ...pod("two", "a", "0Mi"),
    spec: {
      nodeName: "a",
      containers: [
        { name: "x", resources: { requests: { memory: "100Mi" } } },
        { name: "y", resources: { requests: { memory: "50Mi" } } },
      ],
    },
  };
  const failed = { ...pod("failed", "a", "999Mi"), status: { phase: "Failed" } };
  const more = { items: [...pods.items, two, failed] };
  const { nodes: rows } = headroom({ nodes, pods: more, topNodes, topApi, hpa });
  assert.equal(rows[0].requestedMi, 974 + 150);
});

test("an agent exactly as large as what is left fits", () => {
  const { atMax } = headroom({ nodes, pods, topNodes, topApi, hpa });
  const exact = headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: atMax.freeRequestedMi });
  assert.equal(exact.fits.requests, true);
  const over = headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: atMax.freeRequestedMi + 1 });
  assert.equal(over.fits.requests, false);
});

test("packing: an agent on each node leaves room for a cluster agent on neither (256 MiB each)", () => {
  const r = headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: 256, clusterAgentMi: 256 });
  assert.deepEqual(r.packing, { agentOnEachNode: true, clusterAgentFits: false });
});

test("packing: a smaller cluster agent fits on the node with the most room", () => {
  const r = headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: 256, clusterAgentMi: 200 });
  assert.deepEqual(r.packing, { agentOnEachNode: true, clusterAgentFits: true });
});

test("packing: an agent too big for the fuller node is reported", () => {
  const r = headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: 400, clusterAgentMi: 1 });
  assert.equal(r.packing.agentOnEachNode, false);
});

// Review round 2 (pass 1 of the second verification): missing readings, edges and the command itself

test("a node with no reading in kubectl top is refused, not counted as 0 MiB in use", () => {
  const onlyA = "a   209m   11%   1217Mi   83%\n";
  assert.throws(() => headroom({ nodes, pods, topNodes: onlyA, topApi, hpa }), /no memory reading for node b/);
  const unknown = `${onlyA}b   <unknown>   <unknown>   <unknown>   <unknown>\n`;
  assert.throws(() => headroom({ nodes, pods, topNodes: unknown, topApi, hpa }), /no memory reading for node b/);
});

test("with no reading for the API pods, the extra pods are counted at their request, and the result says so", () => {
  const { total, atMax } = headroom({ nodes, pods, topNodes, topApi: "", hpa });
  assert.equal(atMax.apiUseMeasured, false);
  assert.equal(atMax.freeUsedMi, total.freeUsedMi - 3 * 128);
  assert.equal(headroom({ nodes, pods, topNodes, topApi, hpa }).atMax.apiUseMeasured, true);
});

test("an HPA maximum below today's replicas, or no HPA, adds no pods", () => {
  assert.equal(headroom({ nodes, pods, topNodes, topApi, hpa: { spec: { maxReplicas: 1 } } }).atMax.extraPods, 0);
  assert.equal(headroom({ nodes, pods, topNodes, topApi, hpa: undefined }).atMax.extraPods, 0);
});

test("only pods labelled app=api count as API pods", () => {
  const withWeb = { items: [...pods.items, pod("web-1", "a", "512Mi", { app: "web" })] };
  assert.equal(headroom({ nodes, pods: withWeb, topNodes, topApi, hpa }).atMax.extraPods, 3);
});

test("an agent exactly as large as the memory not in use fits by use", () => {
  const { atMax } = headroom({ nodes, pods, topNodes, topApi, hpa });
  assert.equal(headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: atMax.freeUsedMi }).fits.inUse, true);
  assert.equal(headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: atMax.freeUsedMi + 1 }).fits.inUse, false);
});

test("packing at the edges: exactly the room left on a node fits", () => {
  const { nodes: rows } = headroom({ nodes, pods, topNodes, topApi, hpa });
  const smallest = Math.min(...rows.map((r) => r.freeRequestedMi));
  const largest = Math.max(...rows.map((r) => r.freeRequestedMi));
  const edge = headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: smallest, clusterAgentMi: largest - smallest });
  assert.deepEqual(edge.packing, { agentOnEachNode: true, clusterAgentFits: true });
  const over = headroom({ nodes, pods, topNodes, topApi, hpa, agentMi: smallest, clusterAgentMi: largest - smallest + 1 });
  assert.equal(over.packing.clusterAgentFits, false);
});

test("parses fractions and every decimal suffix, and an absent request as 0", () => {
  assert.equal(parseMemory("0.5Gi"), 512);
  assert.equal(parseMemory("1024k"), 1024000 / (1024 * 1024));
  assert.equal(parseMemory("1T"), 1e12 / (1024 * 1024));
  assert.equal(parseMemory(null), 0);
  assert.equal(parseMemory(""), 0);
});

test("counts a pod as the scheduler does: the larger of its init containers and its containers, plus overhead", () => {
  const init = {
    ...pod("init", "a", "128Mi"),
    spec: {
      nodeName: "a",
      initContainers: [{ name: "i", resources: { requests: { memory: "900Mi" } } }],
      containers: [{ name: "c", resources: { requests: { memory: "128Mi" } } }],
      overhead: { memory: "10Mi" },
    },
  };
  const { nodes: rows } = headroom({ nodes, pods: { items: [...pods.items, init] }, topNodes, topApi, hpa });
  assert.equal(rows[0].requestedMi, 974 + 900 + 10);
});

// The command itself, with kubectl replaced by a stub (never the real cluster: KUBECONFIG points nowhere)
const SCRIPT = fileURLToPath(new URL("./memory-headroom.mjs", import.meta.url));

function stubKubectl(behaviour) {
  const dir = mkdtempSync(join(tmpdir(), "mh-stub-"));
  const answers = {
    "get nodes": JSON.stringify(nodes),
    "get pods": JSON.stringify(pods),
    "top nodes": topNodes,
    "top pods": topApi,
    "get hpa": JSON.stringify(hpa),
    "config current-context": "stub-context\n",
  };
  const body = `#!${process.execPath}
const args = process.argv.slice(2).filter((a, i, all) => a !== "-n" && all[i - 1] !== "-n").join(" ");
const behaviour = ${JSON.stringify(behaviour)};
for (const [key, text] of Object.entries(${JSON.stringify(answers)})) {
  if (args.startsWith(key)) {
    if (behaviour.fail === key) { process.stderr.write("stub: " + key + " failed\\n"); process.exit(1); }
    process.stdout.write(text);
    process.exit(0);
  }
}
process.stderr.write("stub: unexpected " + args + "\\n");
process.exit(3);
`;
  writeFileSync(join(dir, "kubectl"), body, { mode: 0o755 });
  return dir;
}

function runScript(env, stubDir) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: stubDir ?? mkdtempSync(join(tmpdir(), "mh-empty-")),
      KUBECONFIG: join(tmpdir(), "no-such-kubeconfig"),
      ...env,
    },
  });
}

test("a size that is not a number of MiB is refused with exit 2 before kubectl runs", () => {
  for (const value of ["abc", "768Mi", " ", "-5"]) {
    const r = runScript({ AGENT_MI: value });
    assert.equal(r.status, 2, `AGENT_MI=${JSON.stringify(value)}`);
    assert.match(r.stderr, /AGENT_MI/);
  }
  assert.equal(runScript({ AGENT_MI: "256", CLUSTER_AGENT_MI: "x" }).status, 2);
});

const posix = process.platform !== "win32";

test("prints the report and exits 0 with a working kubectl", { skip: !posix && "stub needs a POSIX shebang" }, () => {
  const r = runScript({ AGENT_MI: "768" }, stubKubectl({}));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kubectl context stub-context/);
  assert.match(r.stdout, /an agent of 768 MiB: does NOT fit by requests/);
});

test("a failing kubectl call exits 2, also the context lookup after the numbers", { skip: !posix && "stub needs a POSIX shebang" }, () => {
  const top = runScript({}, stubKubectl({ fail: "top nodes" }));
  assert.equal(top.status, 2);
  assert.match(top.stderr, /top nodes failed/);
  const context = runScript({}, stubKubectl({ fail: "config current-context" }));
  assert.equal(context.status, 0, context.stderr);
  assert.match(context.stdout, /kubectl context \(unknown\)/);
});

test("no kubectl on the PATH exits 2", () => {
  assert.equal(runScript({}).status, 2);
});
