// Tests for memory-headroom.mjs: how much memory the nodes have left for monitoring (#55, ARCHITECTURE D18).
import { test } from "node:test";
import assert from "node:assert/strict";
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
