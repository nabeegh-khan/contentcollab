import { Router } from "express";
import type { Latency } from "../lib/status.js";

// GET /api/v1/status (#30, ARCHITECTURE D23): queue depth, request latency and API replicas in one
// JSON document for the status page. Under /api so the Gateway routes it. Each source is read on
// its own: one that fails is null with its reason, and the endpoint still answers 200.
export interface StatusSources {
  queue: () => Promise<number>;
  latency: () => Promise<Latency>;
  /** Ready API replicas, or null while the API cannot read its Deployment (no RBAC yet). */
  replicas: () => Promise<{ api: number } | null>;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** How long one source may take; node-redis queues commands while Redis is down instead of failing. */
export const SOURCE_TIMEOUT_MS = 1000;

class NoAnswer extends Error {}

// The reason a caller sees is "unavailable" or the time limit; the error itself goes to the log, so
// nothing internal (hosts, driver messages) reaches this public endpoint
async function attempt<T>(
  name: string,
  read: () => Promise<T>,
  timeoutMs: number,
): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NoAnswer(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return { ok: true, value: await Promise.race([read(), timeout]) };
  } catch (err) {
    if (err instanceof NoAnswer) return { ok: false, error: err.message };
    console.error(`status: ${name} failed:`, (err as Error).message);
    return { ok: false, error: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export function statusRoutes(sources: StatusSources, timeoutMs = SOURCE_TIMEOUT_MS): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    const [queue, latency, replicas] = await Promise.all([
      attempt("queue", sources.queue, timeoutMs),
      attempt("latency", sources.latency, timeoutMs),
      attempt("replicas", sources.replicas, timeoutMs),
    ]);
    res.set("Cache-Control", "no-store").json({
      generatedAt: new Date().toISOString(),
      replicas: replicas.ok && replicas.value ? replicas.value : { api: null },
      queue: queue.ok ? { waiting: queue.value } : { waiting: null, error: queue.error },
      latency: latency.ok
        ? { ...latency.value, scope: "this API pod" }
        : { requests: null, error: latency.error, scope: "this API pod" },
    });
  });
  return router;
}
