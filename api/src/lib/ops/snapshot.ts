// One operations snapshot (D31): every source read on its own with a time limit, a failure is null plus a reason.
import type { Container } from "./containers.js";
import type { TimelineEvent } from "./events.js";
import type { HpaCard } from "./hpa.js";
import type { LogLine } from "./logs.js";
import type { NodeCard } from "./nodes.js";
import type { TrafficCard } from "./traffic.js";
import { log } from "../log.js";

export interface ClaimCard {
  name: string;
  phase: string;
  capacity: string | null;
  storageClass: string | null;
}

/** A source is a function that reads one card, or null when it cannot run here ("not configured"). */
type Source<T> = (() => Promise<T>) | null;

export interface OpsSources {
  containers: Source<Container[]>;
  hpa: Source<HpaCard>;
  nodes: Source<NodeCard[]>;
  traffic: Source<TrafficCard>;
  claim: Source<ClaimCard>;
  counts: Source<{ documents: number; versions: number; comments: number }>;
  events: Source<TimelineEvent[]>;
  logs: Source<{ lines: LogLine[]; hidden: number }>;
  /** When the next drill may start (ISO time), or null; left out where there are no drills. */
  nextDrill?: Source<string | null> | undefined;
}

export const SOURCE_TIMEOUT_MS = 1000;
export const CACHE_SECONDS = 5;
const NAMESPACE = "contentcollab";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

class NoAnswer extends Error {}

async function attempt<T>(name: string, source: Source<T>, timeoutMs: number): Promise<Outcome<T>> {
  if (!source) return { ok: false, error: "not configured" };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NoAnswer(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return { ok: true, value: await Promise.race([source(), timeout]) };
  } catch (err) {
    if (err instanceof NoAnswer) return { ok: false, error: err.message };
    // The reason for the log, not for the client: it can hold hosts and driver text
    log("warn", "ops: a source failed", {
      component: "ops",
      source: name,
      // The kind and message, no stack: this repeats every window while the panel is open
      error: err instanceof Error ? { kind: err.name, message: err.message } : String(err),
    });
    return { ok: false, error: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

const valueOr = <T>(outcome: Outcome<T>): T | null => (outcome.ok ? outcome.value : null);

export async function buildSnapshot(
  sources: OpsSources,
  options: { grafanaUrl: string | null; timeoutMs?: number },
) {
  const limit = options.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const [containers, hpa, nodes, traffic, claim, counts, events, logs, nextDrill] =
    await Promise.all([
      attempt("containers", sources.containers, limit),
      attempt("hpa", sources.hpa, limit),
      attempt("nodes", sources.nodes, limit),
      attempt("traffic", sources.traffic, limit),
      attempt("claim", sources.claim, limit),
      attempt("counts", sources.counts, limit),
      attempt("events", sources.events, limit),
      attempt("logs", sources.logs, limit),
      sources.nextDrill
        ? attempt("nextDrill", sources.nextDrill, limit)
        : { ok: true as const, value: null },
    ]);
  const named = { containers, hpa, nodes, traffic, claim, counts, events, logs, nextDrill };
  const errors = Object.fromEntries(
    Object.entries(named).flatMap(([name, outcome]) => (outcome.ok ? [] : [[name, outcome.error]])),
  );
  const counted = valueOr(counts);
  return {
    generatedAt: new Date().toISOString(),
    cachedForSeconds: CACHE_SECONDS,
    namespace: NAMESPACE,
    errors,
    containers: valueOr(containers),
    hpa: valueOr(hpa),
    nodes: valueOr(nodes),
    traffic: valueOr(traffic),
    storage: {
      claim: valueOr(claim),
      documents: counted?.documents ?? null,
      versions: counted?.versions ?? null,
      comments: counted?.comments ?? null,
    },
    events: valueOr(events) ?? [],
    logs: valueOr(logs) ?? { lines: [], hidden: 0 },
    drills: { nextAllowedAt: valueOr(nextDrill) ?? null },
    links: { grafana: options.grafanaUrl },
  };
}
