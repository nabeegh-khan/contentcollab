import { Router } from "express";
import { z } from "zod";
import { DrillRateLimited, type DrillTarget } from "../lib/ops/drill.js";
import { validate } from "../lib/validate.js";
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
  /** The restart drill (D31); without it the route is not there (not in a cluster). */
  drill?: (target: DrillTarget, actorUserId: string) => Promise<object>;
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
  const { drill } = options;
  if (drill) {
    // Only the two targets: the code picks the pod, so a client can never name one
    const body = z.strictObject({ target: z.enum(["api", "postgres"]) });
    router.post("/drills", validate(body), async (req, res) => {
      try {
        const done = await drill(req.body.target, res.locals.userId as string);
        res.set("Cache-Control", "no-store").json(done);
      } catch (error) {
        if (error instanceof DrillRateLimited) {
          res.set("Retry-After", String(error.retryAfterSeconds));
        }
        throw error;
      }
    });
  }
  return router;
}
