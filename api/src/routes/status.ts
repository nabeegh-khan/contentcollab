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

async function attempt<T>(read: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function statusRoutes(sources: StatusSources): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    const [queue, latency, replicas] = await Promise.all([
      attempt(sources.queue),
      attempt(sources.latency),
      attempt(sources.replicas),
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
