import { Router } from "express";
import { pingPostgres } from "../lib/db.js";
import { pingRedis } from "../lib/redis.js";

const router = Router();

// Public. Kubernetes and Compose call this; 503 means "do not send traffic yet".
router.get("/", async (req, res) => {
  const [postgres, redis] = await Promise.all([pingPostgres(), pingRedis()]);
  const ok = postgres && redis;
  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    postgres: postgres ? "ok" : "down",
    redis: redis ? "ok" : "down",
  });
});

export default router;
