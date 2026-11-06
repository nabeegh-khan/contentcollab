#!/usr/bin/env node
// Stepped load test for the API autoscaler (#69). Node 24, no dependencies.
//
//   BASE=https://<host> node scripts/loadtest.mjs                 # steps 10,25,50,100,200 req/s, 60 s each
//   BASE=... STEPS=20,40 STEP_SECONDS=30 node scripts/loadtest.mjs     # custom steps
//   BASE=... ROLLOUT=1 SKIP_HPA_CHECK=1 STEPS=50 STEP_SECONDS=120 node scripts/loadtest.mjs
//        # constant load; halfway through, `kubectl rollout restart deployment/api`
//        # runs, and every failed request during the rollout is counted
//
// Run from the repository root (results go to docs/loadtest/). Before a
// scaling run it checks that hpa/api can read CPU and stops if not;
// SKIP_HPA_CHECK=1 skips that for runs that do not measure scaling.
//
// For each step it prints achieved req/s, p50 and p95 latency, the error rate
// and, when kubectl can reach the cluster, the API replica count the HPA has
// set by the end of the step. Results also go to docs/loadtest/<timestamp>.csv
// for the final report.
//
// Node memory (MAX_NODE_MEMORY_PCT, default 95) and the replica count are read
// from kubectl's current context, which must be the cluster behind BASE.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { hpaReadiness, readHpa } from "./hpa-ready.mjs";
import { failureReason, summarizeFailures, parseTopNodes, overMemory } from "./loadtest-lib.mjs";

const BASE = process.env.BASE;
if (!BASE) {
  console.error("BASE is required, e.g. BASE=https://contentcollab.example node scripts/loadtest.mjs");
  process.exit(1);
}
const PATH = process.env.TARGET_PATH ?? "/health";
const STEPS = (process.env.STEPS ?? "10,25,50,100,200").split(",").map(Number);
const SECONDS = Number(process.env.STEP_SECONDS ?? 60);
const ROLLOUT = process.env.ROLLOUT === "1";
const NS = process.env.NAMESPACE ?? "contentcollab";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 5000);
// Stop the run if any node's memory goes above this (kubectl top nodes, every 15 s)
const MAX_NODE_MEMORY_PCT = Number(process.env.MAX_NODE_MEMORY_PCT ?? 95);
if (!(MAX_NODE_MEMORY_PCT > 0 && MAX_NODE_MEMORY_PCT <= 100)) {
  console.error(`MAX_NODE_MEMORY_PCT must be a number from 1 to 100, got "${process.env.MAX_NODE_MEMORY_PCT}"`);
  process.exit(1);
}

// An HPA that cannot read CPU never scales, and a flat replica count would
// then pass for the cluster's limit (ARCHITECTURE D5). SKIP_HPA_CHECK=1 for
// runs that do not measure scaling, e.g. ROLLOUT=1 at a fixed rate.
if (process.env.SKIP_HPA_CHECK !== "1") {
  const read = readHpa(NS);
  if (read.unreachable) {
    console.warn(`no cluster (${read.error.split("\n")[0]}): hpa/api in ${NS} not checked; the replicas column will show -`);
  } else if (!read.hpa) {
    console.error(`cannot read hpa/api in ${NS}: ${read.error}`);
    process.exit(1);
  } else {
    const { ok, reason } = hpaReadiness(read.hpa);
    if (!ok) {
      console.error(`hpa/api cannot scale: ${reason}. Run scripts/metrics-server.sh, or set SKIP_HPA_CHECK=1.`);
      process.exit(1);
    }
  }
}

function kubectl(args) {
  try {
    return execFileSync("kubectl", ["-n", NS, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null; // no cluster access: replicas column shows "-"
  }
}

const replicas = () => kubectl(["get", "deployment", "api", "-o", "jsonpath={.status.readyReplicas}"]) ?? "-";

async function one(latencies, counts) {
  const start = performance.now();
  let reason;
  try {
    const res = await fetch(BASE + PATH, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer();
    reason = failureReason(res);
  } catch (err) {
    reason = failureReason(null, err);
  }
  if (reason) {
    counts.fail++;
    counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
  } else {
    counts.ok++;
  }
  latencies.push(performance.now() - start);
}

// Node memory, polled without blocking the request timer. One poll at a time,
// each limited to 10 s; the peak goes to the step that started the poll.
const run = promisify(execFile);
const memory = { over: null, polling: false };
async function pollMemory(stepStats) {
  if (memory.polling) return;
  memory.polling = true;
  try {
    const { stdout } = await run("kubectl", ["top", "nodes", "--no-headers"], { timeout: 10000 });
    const nodes = parseTopNodes(stdout);
    for (const n of nodes) stepStats.peak = Math.max(stepStats.peak, n.memoryPct);
    memory.over ??= overMemory(nodes, MAX_NODE_MEMORY_PCT);
  } catch {
    // no metrics: the guard cannot act, said once at the start
  } finally {
    memory.polling = false;
  }
}

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

async function step(rate, seconds, midway) {
  const latencies = [];
  const counts = { ok: 0, fail: 0, byReason: {} };
  const stats = { peak: 0 };
  const inflight = new Set();
  const tickMs = 100;
  let sent = 0; // requests due so far follow elapsed time, so timer drift does not lower the rate
  const started = Date.now();
  let midwayDone = false;
  let lastPoll = 0;
  while (Date.now() - started < seconds * 1000 && !memory.over) {
    if (Date.now() - lastPoll >= 15000) {
      lastPoll = Date.now();
      pollMemory(stats);
    }
    const due = Math.floor((rate * (Date.now() - started)) / 1000);
    while (sent < due) {
      const p = one(latencies, counts).finally(() => inflight.delete(p));
      inflight.add(p);
      sent++;
    }
    if (midway && !midwayDone && Date.now() - started >= (seconds * 1000) / 2) {
      midwayDone = true;
      midway();
    }
    await new Promise((r) => setTimeout(r, tickMs));
  }
  const sendSeconds = (Date.now() - started) / 1000; // before waiting for in-flight requests
  await Promise.all(inflight);
  const sorted = latencies.sort((a, b) => a - b);
  const total = counts.ok + counts.fail;
  return {
    target: rate,
    achieved: (sendSeconds > 0 ? total / sendSeconds : 0).toFixed(1),
    p50: pct(sorted, 50).toFixed(0),
    p95: pct(sorted, 95).toFixed(0),
    errors: total ? ((100 * counts.fail) / total).toFixed(2) : "0.00",
    failed: counts.fail,
    failures: summarizeFailures(counts.byReason),
    peakMemory: stats.peak || "-",
    replicas: replicas(),
    stopped: memory.over ? `${memory.over.node}@${memory.over.memoryPct}%` : "",
  };
}

const rows = [];
console.log(`Target ${BASE}${PATH}, ${SECONDS} s per step${ROLLOUT ? ", rolling restart halfway" : ""}`);
const startStats = { peak: 0 };
await pollMemory(startStats);
if (!startStats.peak) console.warn("kubectl top nodes gave nothing: the node-memory guard is off for this run");
if (memory.over) {
  console.error(`not starting: ${memory.over.node} is already at ${memory.over.memoryPct}% memory (limit ${MAX_NODE_MEMORY_PCT}%)`);
  process.exit(1);
}
console.log("| target req/s | achieved req/s | p50 ms | p95 ms | errors % | failed | failure reasons | peak node memory % | API replicas |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const rate of STEPS) {
  const midway = ROLLOUT ? () => kubectl(["rollout", "restart", "deployment/api"]) : null;
  const r = await step(rate, SECONDS, midway);
  rows.push(r);
  console.log(
    `| ${r.target} | ${r.achieved} | ${r.p50} | ${r.p95} | ${r.errors} | ${r.failed} | ${r.failures || "-"} | ${r.peakMemory} | ${r.replicas} |`,
  );
  if (memory.over) {
    console.error(`STOPPED: ${memory.over.node} at ${memory.over.memoryPct}% memory (limit ${MAX_NODE_MEMORY_PCT}%)`);
    break;
  }
}

mkdirSync("docs/loadtest", { recursive: true });
const file = `docs/loadtest/${new Date().toISOString().replace(/[:.]/g, "-")}${ROLLOUT ? "-rollout" : ""}.csv`;
writeFileSync(
  file,
  "target,achieved,p50_ms,p95_ms,error_pct,failed,failure_reasons,peak_node_memory_pct,replicas,stopped\n" +
    rows
      .map((r) =>
        [r.target, r.achieved, r.p50, r.p95, r.errors, r.failed, r.failures, r.peakMemory, r.replicas, r.stopped].join(","),
      )
      .join("\n") +
    "\n",
);
console.log(`Saved ${file}`);
