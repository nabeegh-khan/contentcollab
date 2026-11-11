#!/usr/bin/env node
// How much memory the nodes have left for monitoring (#55, ARCHITECTURE D18). Read-only: kubectl get and top.
//
//   node scripts/memory-headroom.mjs                 # per node, then with the API at the autoscaler's maximum
//   AGENT_MI=768 node scripts/memory-headroom.mjs    # also says whether an agent of that size fits
//   NAMESPACE=contentcollab HPA=api node scripts/memory-headroom.mjs
//
// "Unrequested" is allocatable memory minus the memory requests of the pods on the node (what the scheduler can
// still place). "Not in use" is allocatable minus what the node's pods actually use (what stops a node running
// out of memory under load). With the API at its maximum, each extra pod adds one API pod's request and use.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const KI_PER_MI = 1024;
const MI_PER_GI = 1024;
const BYTES_PER_MI = 1024 * 1024;
const DECIMALS = 1;

const UNITS = { Ki: 1 / KI_PER_MI, Mi: 1, Gi: MI_PER_GI };

/** @returns {number} a Kubernetes memory quantity in MiB; 0 when absent */
export function parseMemory(quantity) {
  if (quantity === undefined || quantity === null || quantity === "") return 0;
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi)?$/.exec(String(quantity));
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2] ? value * UNITS[match[2]] : value / BYTES_PER_MI;
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
export function headroom({ nodes, pods, topNodes, topApi, hpa, agentMi }) {
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
  return { nodes: rows, total, atMax, fits };
}

function kubectl(args) {
  return execFileSync("kubectl", args, { encoding: "utf8", maxBuffer: 64 * BYTES_PER_MI });
}

function main() {
  const namespace = process.env.NAMESPACE ?? "contentcollab";
  const hpaName = process.env.HPA ?? "api";
  const agentMi = process.env.AGENT_MI === undefined ? undefined : Number(process.env.AGENT_MI);
  let result;
  try {
    result = headroom({
      nodes: JSON.parse(kubectl(["get", "nodes", "-o", "json"])),
      pods: JSON.parse(kubectl(["get", "pods", "-A", "-o", "json"])),
      topNodes: kubectl(["top", "nodes", "--no-headers"]),
      topApi: kubectl(["-n", namespace, "top", "pods", "-l", "app=api", "--no-headers"]),
      hpa: JSON.parse(kubectl(["-n", namespace, "get", "hpa", hpaName, "-o", "json"])),
      agentMi,
    });
  } catch (err) {
    console.error(`kubectl failed: ${String(err.stderr ?? err.message).trim()}`);
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
      `an agent of ${agentMi} MiB: ${result.fits.requests ? "fits" : "does NOT fit"} by requests, ${result.fits.inUse ? "fits" : "does NOT fit"} by memory in use`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
