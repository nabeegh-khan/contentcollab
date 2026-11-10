#!/usr/bin/env node
// Stepped load test for the API autoscaler (#69). Node 24, no dependencies.
//
//   BASE=https://<host> node scripts/loadtest.mjs                 # steps 10,25,50,100,200 req/s, 60 s each
//   BASE=... STEPS=20,40 STEP_SECONDS=30 node scripts/loadtest.mjs     # custom steps
//   BASE=... ROLLOUT=1 SKIP_HPA_CHECK=1 STEPS=50 STEP_SECONDS=120 node scripts/loadtest.mjs
//        # constant load; halfway through, `kubectl rollout restart deployment/api`
//        # runs, and every failed request during the rollout is counted. The run
//        # exits 1 if the restart fails or the rollout does not finish inside the
//        # step, so "0 failed" always means a rollout really happened under load.
//
// Run from the repository root (results go to docs/loadtest/). Before a
// scaling run it checks that hpa/api can read CPU and stops if it cannot; with
// no reachable cluster it warns and continues (the replicas column shows -).
// SKIP_HPA_CHECK=1 skips the check for runs that do not measure scaling.
// From Git Bash set MSYS_NO_PATHCONV=1 before a TARGET_PATH, or Git Bash
// rewrites "/health" into a Windows path.
//
// For each step it prints the rate requests were sent at, the rate of
// successful responses (what the server served), p50 and p95 latency of the
// successes, the error rate (any 4xx or 5xx, timeout or network error) and,
// when kubectl can reach the cluster, the API's ready replicas at the end of
// the step. Results also go to docs/loadtest/<timestamp>.csv
// for the final report, with <timestamp>-failures.csv (time, step and reason
// of every failed request) and <timestamp>-scaling.csv (HPA desired, pods
// created and ready every 2 s, and the HPA's rescale events), so failures can
// be lined up with pods being added (ALIGN_WINDOW_S, default 30).
//
// Node memory (MAX_NODE_MEMORY_PCT, default 95) and the replica count are read
// from kubectl's current context, which must be the cluster behind BASE.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { hpaReadiness, readHpa } from "./hpa-ready.mjs";
import {
  readConfig,
  summarizeStep,
  failureReason,
  parseTopNodes,
  overMemory,
  scalingChanges,
  alignFailures,
} from "./loadtest-lib.mjs";

const BASE = process.env.BASE;
if (!BASE) {
  console.error("BASE is required, e.g. BASE=https://contentcollab.example node scripts/loadtest.mjs");
  process.exit(1);
}
const PATH = process.env.TARGET_PATH ?? "/health";
const ROLLOUT = process.env.ROLLOUT === "1";
const NS = process.env.NAMESPACE ?? "contentcollab";
const { config, error: configError } = readConfig(process.env);
if (configError) {
  console.error(configError);
  process.exit(1);
}
const STEPS = config.steps;
const SECONDS = config.stepSeconds;
const TIMEOUT_MS = config.timeoutMs;
// Stop the run if any node's memory goes above this (kubectl top nodes, every 15 s)
const MAX_NODE_MEMORY_PCT = config.maxNodeMemoryPct;
const ALIGN_WINDOW_S = config.alignWindowS;

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

const failureLog = []; // { t, target, reason }

async function one(okLatencies, counts, target) {
  const sentAt = Date.now(); // a timeout is placed when it was sent, not TIMEOUT_MS later
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
    failureLog.push({ t: sentAt, target, reason });
    counts.fail++;
    counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
  } else {
    counts.ok++;
    okLatencies.push(performance.now() - start); // latency of successes only
  }
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

// HPA desired, pods created and pods ready, sampled every 2 s; one read at a time
const timeline = { samples: [], sampling: false };
async function sampleScaling() {
  if (timeline.sampling) return;
  timeline.sampling = true;
  try {
    const { stdout } = await run("kubectl", ["-n", NS, "get", "hpa/api", "deployment/api", "-o", "json"], {
      timeout: 5000,
    });
    const items = JSON.parse(stdout).items ?? [];
    const hpa = items.find((i) => i.kind === "HorizontalPodAutoscaler");
    const dep = items.find((i) => i.kind === "Deployment");
    timeline.samples.push({
      t: Date.now(),
      desired: hpa?.status?.desiredReplicas ?? null,
      replicas: dep?.status?.replicas ?? 0,
      ready: dep?.status?.readyReplicas ?? 0,
    });
  } catch {
    // no cluster: no timeline
  } finally {
    timeline.sampling = false;
  }
}

/** The HPA's SuccessfulRescale events since `since` (ms), oldest first. */
function rescaleEvents(since) {
  const out = kubectl([
    "get",
    "events",
    "--field-selector",
    "involvedObject.kind=HorizontalPodAutoscaler,involvedObject.name=api,reason=SuccessfulRescale",
    "-o",
    "json",
  ]);
  if (!out) return [];
  return (JSON.parse(out).items ?? [])
    .map((e) => ({ t: Date.parse(e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp), message: e.message }))
    .filter((e) => e.t >= since - 1000)
    .sort((a, b) => a.t - b.t);
}

/**
 * Restarts deployment/api without blocking the request timer, then waits for the
 * rollout to finish before `deadline` (ms), the end of the step, so it finishes
 * while load is still being sent. Resolves to "complete", "incomplete: ..." or
 * "restart failed: ...", never throws.
 */
async function rolloutRestart(deadline) {
  // kubectl prints its own summary last, after any client-go log lines; one CSV-safe line, at most 120 characters
  const reason = (err) =>
    String(err.stderr || err.message)
      .trim()
      .split(/\r?\n/)
      .pop()
      .replace(/[,"\\]/g, " ")
      .slice(0, 120)
      .trim();
  try {
    await run("kubectl", ["-n", NS, "rollout", "restart", "deployment/api"], { timeout: 15000 });
  } catch (err) {
    return `restart failed: ${reason(err)}`;
  }
  const timeout = Math.floor((deadline - Date.now()) / 1000);
  if (timeout < 1) return "incomplete: no time left in the step after the restart";
  try {
    await run("kubectl", ["-n", NS, "rollout", "status", "deployment/api", `--timeout=${timeout}s`], {
      timeout: (timeout + 10) * 1000,
    });
    return "complete";
  } catch (err) {
    return `incomplete: ${reason(err)}`;
  }
}

async function step(rate, seconds, midway) {
  const okLatencies = [];
  const counts = { ok: 0, fail: 0, byReason: {} };
  const stats = { peak: 0 };
  const inflight = new Set();
  const tickMs = 100;
  let sent = 0; // requests due so far follow elapsed time, so timer drift does not lower the rate
  const started = Date.now();
  let lastSendAt = started;
  let midwayResult = null; // the rollout's promise, started once halfway
  let lastPoll = 0;
  while (Date.now() - started < seconds * 1000 && !memory.over) {
    if (Date.now() - lastPoll >= 15000) {
      lastPoll = Date.now();
      pollMemory(stats);
    }
    const due = Math.floor((rate * (Date.now() - started)) / 1000);
    while (sent < due) {
      const p = one(okLatencies, counts, rate).finally(() => inflight.delete(p));
      inflight.add(p);
      sent++;
      lastSendAt = Date.now();
    }
    if (midway && !midwayResult && Date.now() - started >= (seconds * 1000) / 2) {
      midwayResult = midway(started + seconds * 1000); // async: requests keep going out while kubectl runs
    }
    await new Promise((r) => setTimeout(r, tickMs));
  }
  const sendSeconds = (lastSendAt - started) / 1000; // up to the last send, not the sleep after it
  await Promise.all(inflight);
  let rollout = "";
  if (midwayResult) rollout = await midwayResult;
  else if (midway) rollout = "not started (step stopped early)";
  return {
    ...summarizeStep({ target: rate, sendSeconds, okLatencies, ...counts }),
    rollout,
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
const runStarted = Date.now();
await sampleScaling();
const sampler = setInterval(sampleScaling, 2000);
console.log(
  "| target req/s | sent req/s | ok req/s | p50 ms | p95 ms | errors % | failed | failure reasons | rollout | peak node memory % | API ready replicas |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const rate of STEPS) {
  const r = await step(rate, SECONDS, ROLLOUT ? rolloutRestart : null);
  rows.push(r);
  console.log(
    `| ${r.target} | ${r.sentPerS} | ${r.okPerS} | ${r.p50} | ${r.p95} | ${r.errors} | ${r.failed} | ${r.failures || "-"} | ${r.rollout || "-"} | ${r.peakMemory} | ${r.replicas} |`,
  );
  if (memory.over) {
    console.error(`STOPPED: ${memory.over.node} at ${memory.over.memoryPct}% memory (limit ${MAX_NODE_MEMORY_PCT}%)`);
    break;
  }
  if (r.rollout && r.rollout !== "complete") break; // later steps would only add load to a failed test
}

clearInterval(sampler);
await sampleScaling();

mkdirSync("docs/loadtest", { recursive: true });
const stem = `docs/loadtest/${new Date().toISOString().replace(/[:.]/g, "-")}${ROLLOUT ? "-rollout" : ""}`;
const file = `${stem}.csv`;
writeFileSync(
  file,
  "target,sent_per_s,ok_per_s,p50_ms,p95_ms,error_pct,failed,failure_reasons,rollout,peak_node_memory_pct,ready_replicas,stopped\n" +
    rows
      .map((r) =>
        [
          r.target,
          r.sentPerS,
          r.okPerS,
          r.p50,
          r.p95,
          r.errors,
          r.failed,
          r.failures,
          r.rollout,
          r.peakMemory,
          r.replicas,
          r.stopped,
        ].join(","),
      )
      .join("\n") +
    "\n",
);
console.log(`Saved ${file}`);

const iso = (ms) => new Date(ms).toISOString();
writeFileSync(
  `${stem}-failures.csv`,
  "time,step_target,reason\n" + failureLog.map((f) => [iso(f.t), f.target, f.reason].join(",")).join("\n") + "\n",
);
const events = rescaleEvents(runStarted);
writeFileSync(
  `${stem}-scaling.csv`,
  "time,source,hpa_desired,pods_created,pods_ready,event\n" +
    [
      ...timeline.samples.map((s) => ({ t: s.t, row: [iso(s.t), "sample", s.desired ?? "", s.replicas, s.ready, ""] })),
      ...events.map((e) => ({ t: e.t, row: [iso(e.t), "event", "", "", "", e.message.replace(/[,\r\n"]/g, " ")] })),
    ]
      .sort((a, b) => a.t - b.t)
      .map((r) => r.row.join(","))
      .join("\n") +
    "\n",
);
console.log(`Saved ${stem}-failures.csv and ${stem}-scaling.csv`);

if (timeline.samples.length) {
  const changes = scalingChanges(timeline.samples);
  for (const c of changes) console.log(`${iso(c.t)} pods ${c.kind}: ${c.from} -> ${c.to}`);
  for (const e of events) console.log(`${iso(e.t)} HPA: ${e.message}`);
  const a = alignFailures(
    failureLog.map((f) => f.t),
    changes,
    ALIGN_WINDOW_S * 1000,
  );
  console.log(
    `${a.inWindow} of ${a.total} failures came within ${ALIGN_WINDOW_S} s after a pod was added or turned ready; ` +
      `${a.beforeAnyChange} came before any such change`,
  );
}

// A rollout run whose restart failed or did not finish proves nothing about dropped requests
const badRollout = rows.find((r) => r.rollout && r.rollout !== "complete");
if (badRollout) {
  console.error(`rollout ${badRollout.rollout}: the failed-request count does not cover a rolling update`);
  process.exit(1);
}
// A run stopped by the memory guard has not covered every step
if (memory.over) process.exit(1);
