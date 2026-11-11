#!/usr/bin/env node
// How much memory the nodes have left for monitoring (#55, ARCHITECTURE D18). Read-only: kubectl get and top.
//
//   node scripts/memory-headroom.mjs                 # per node, then with the API at the autoscaler's maximum
//   AGENT_MI=768 node scripts/memory-headroom.mjs    # also says whether an agent of that size fits (in total)
//   AGENT_MI=256 CLUSTER_AGENT_MI=256 node scripts/memory-headroom.mjs   # and whether it can be placed: one per node, then one more
//   NAMESPACE=contentcollab HPA=api node scripts/memory-headroom.mjs
//
// "Unrequested" is allocatable memory minus the memory requests of the pods on the node (what the scheduler can
// still place). "Not in use" is allocatable minus what the node's pods actually use (what stops a node running
// out of memory under load). With the API at its maximum, each extra pod adds one API pod's request and use.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const BYTES_PER_MI = 1024 * 1024;
const DECIMALS = 1;

const BYTES_PER_UNIT = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
};

// A Kubernetes quantity: digits with an optional fraction or exponent, then an optional binary (Ki Mi Gi Ti) or
// decimal (k M G T) suffix. Matches "1499736Ki", "256M", "129e6", "0.5Gi"; rejects "100m" (milli), "lots" and "".
// Try it: https://regex101.com/?regex=%5E(%5Cd%2B(%3F%3A%5C.%5Cd%2B)%3F(%3F%3Ae%5Cd%2B)%3F)(Ki%7CMi%7CGi%7CTi%7Ck%7CM%7CG%7CT)%3F%24
const QUANTITY = /^(\d+(?:\.\d+)?(?:e\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/;

/**
 * @returns {number} a Kubernetes memory quantity in MiB; 0 when absent
 * @throws {Error} on a quantity it cannot read, so a pod is never silently counted as 0
 */
export function parseMemory(quantity) {
  if (quantity === undefined || quantity === null || quantity === "") return 0;
  const match = QUANTITY.exec(String(quantity));
  if (!match) throw new Error(`unreadable memory quantity: ${JSON.stringify(quantity)}`);
  const bytes = Number(match[1]) * (match[2] ? BYTES_PER_UNIT[match[2]] : 1);
  return bytes / BYTES_PER_MI;
}

// Rows of `kubectl top ... --no-headers`: name, cpu, [cpu%], memory, [memory%]; the memory is the first "Mi" or "Gi" cell
function topMemoryByName(text) {
  const result = new Map();
  for (const row of (text ?? "").split("\n")) {
    const cells = row.trim().split(/\s+/);
    const memory = cells.find((c, i) => i > 0 && /^\d+(Ki|Mi|Gi)$/.test(c));
    if (cells[0] && memory) result.set(cells[0], parseMemory(memory));
  }
  return result;
}

const sum = (values) => values.reduce((a, b) => a + b, 0);
const round = (n) => Math.round(n * 10 ** DECIMALS) / 10 ** DECIMALS;

/**
 * @param {{nodes: object, pods: object, topNodes: string, topApi: string, hpa: object, agentMi?: number}} input
 *   the JSON of `kubectl get nodes` and `get pods -A`, the text of `top nodes --no-headers` and of `top pods -l app=api
 *   --no-headers`, and the API's HorizontalPodAutoscaler
 */
export function headroom({ nodes, pods, topNodes, topApi, hpa, agentMi, clusterAgentMi }) {
  const used = topMemoryByName(topNodes);
  const live = pods.items.filter((p) => !["Succeeded", "Failed"].includes(p.status?.phase));
  const requestOf = (p) =>
    sum(p.spec.containers.map((c) => parseMemory(c.resources?.requests?.memory)));

  const rows = nodes.items.map((n) => {
    const name = n.metadata.name;
    const allocatableMi = parseMemory(n.status.allocatable.memory);
    const requestedMi = sum(live.filter((p) => p.spec.nodeName === name).map(requestOf));
    const usedMi = used.get(name) ?? 0;
    return {
      name,
      allocatableMi,
      requestedMi,
      usedMi,
      freeRequestedMi: allocatableMi - requestedMi,
      freeUsedMi: allocatableMi - usedMi,
    };
  });

  const total = {
    allocatableMi: sum(rows.map((r) => r.allocatableMi)),
    requestedMi: sum(rows.map((r) => r.requestedMi)),
    usedMi: sum(rows.map((r) => r.usedMi)),
    freeRequestedMi: sum(rows.map((r) => r.freeRequestedMi)),
    freeUsedMi: sum(rows.map((r) => r.freeUsedMi)),
  };

  const apiPods = live.filter((p) => p.metadata.labels?.app === "api");
  const apiUse = [...topMemoryByName(topApi).values()];
  const perPodRequest = apiPods.length ? sum(apiPods.map(requestOf)) / apiPods.length : 0;
  const perPodUse = apiUse.length ? sum(apiUse) / apiUse.length : perPodRequest;
  const extraPods = Math.max(0, (hpa?.spec?.maxReplicas ?? apiPods.length) - apiPods.length);
  const atMax = {
    extraPods,
    freeRequestedMi: total.freeRequestedMi - extraPods * perPodRequest,
    freeUsedMi: total.freeUsedMi - extraPods * perPodUse,
  };

  const fits =
    agentMi === undefined
      ? undefined
      : { requests: agentMi <= atMax.freeRequestedMi, inUse: agentMi <= atMax.freeUsedMi };

  // Totals can fit when no placement does: one agent on every node (a DaemonSet) and then a cluster agent on a node
  // that still has room, by the requests of today's pods (the API's extra pods are not placed here)
  let packing;
  if (agentMi !== undefined && clusterAgentMi !== undefined) {
    const left = rows.map((r) => r.freeRequestedMi - agentMi);
    packing = {
      agentOnEachNode: left.every((free) => free >= 0),
      clusterAgentFits: left.some((free) => free >= clusterAgentMi),
    };
  }
  return { nodes: rows, total, atMax, fits, packing };
}

function kubectl(args) {
  return execFileSync("kubectl", args, { encoding: "utf8", maxBuffer: 64 * BYTES_PER_MI });
}

function main() {
  const namespace = process.env.NAMESPACE ?? "contentcollab";
  const hpaName = process.env.HPA ?? "api";
  const agentMi = process.env.AGENT_MI === undefined ? undefined : Number(process.env.AGENT_MI);
  const clusterAgentMi =
    process.env.CLUSTER_AGENT_MI === undefined ? undefined : Number(process.env.CLUSTER_AGENT_MI);
  let result;
  try {
    result = headroom({
      nodes: JSON.parse(kubectl(["get", "nodes", "-o", "json"])),
      pods: JSON.parse(kubectl(["get", "pods", "-A", "-o", "json"])),
      topNodes: kubectl(["top", "nodes", "--no-headers"]),
      topApi: kubectl(["-n", namespace, "top", "pods", "-l", "app=api", "--no-headers"]),
      hpa: JSON.parse(kubectl(["-n", namespace, "get", "hpa", hpaName, "-o", "json"])),
      agentMi,
      clusterAgentMi,
    });
  } catch (err) {
    console.error(`failed: ${String(err.stderr ?? err.message).trim()}`);
    process.exit(2);
  }
  const mi = (n) => `${round(n)} MiB`;
  console.log(`measured ${new Date().toISOString()} (kubectl context ${kubectl(["config", "current-context"]).trim()})`);
  for (const r of result.nodes) {
    console.log(
      `${r.name}: allocatable ${mi(r.allocatableMi)}, requested ${mi(r.requestedMi)} (unrequested ${mi(r.freeRequestedMi)}), ` +
        `in use ${mi(r.usedMi)} (not in use ${mi(r.freeUsedMi)})`,
    );
  }
  console.log(`both: unrequested ${mi(result.total.freeRequestedMi)}, not in use ${mi(result.total.freeUsedMi)}`);
  console.log(
    `API at its maximum (+${result.atMax.extraPods} pods): unrequested ${mi(result.atMax.freeRequestedMi)}, not in use ${mi(result.atMax.freeUsedMi)}`,
  );
  if (result.fits) {
    console.log(
      `an agent of ${agentMi} MiB: ${result.fits.requests ? "fits" : "does NOT fit"} by requests, ${result.fits.inUse ? "fits" : "does NOT fit"} by memory in use (totals, API at its maximum)`,
    );
  }
  if (result.packing) {
    console.log(
      `placement by today's requests: an agent of ${agentMi} MiB on each node ${result.packing.agentOnEachNode ? "fits" : "does NOT fit"}; ` +
        `then a cluster agent of ${clusterAgentMi} MiB ${result.packing.clusterAgentFits ? "fits on a node" : "fits on NO node"}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
