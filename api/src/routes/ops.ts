import { Router } from "express";
import { cachedFor } from "../lib/replicas.js";
import {
  buildSnapshot,
  CACHE_SECONDS,
  SOURCE_TIMEOUT_MS,
  type OpsSources,
} from "../lib/ops/snapshot.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireOpsAdmin } from "../middleware/requireOpsAdmin.js";

export type { OpsSources };

const MS_PER_SECOND = 1000;

export interface OpsOptions {
  env?: Record<string, string | undefined>;
  ttlMs?: number;
  now?: () => number;
  grafanaUrl: string | null;
  timeoutMs?: number;
}

// GET /api/v1/ops (D31): cluster internals for the operations panel. Sign-in and the admin check sit on
// the whole router, so every route added here has both; the snapshot is built at most once per window.
export function opsRoutes(sources: OpsSources, options: OpsOptions): Router {
  const router = Router();
  router.use(requireAuth, requireOpsAdmin(options.env));
  const snapshot = cachedFor(
    options.ttlMs ?? CACHE_SECONDS * MS_PER_SECOND,
    () =>
      buildSnapshot(sources, {
        grafanaUrl: options.grafanaUrl,
        timeoutMs: options.timeoutMs ?? SOURCE_TIMEOUT_MS,
      }),
    options.now,
  );
  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await snapshot());
  });
  return router;
}
