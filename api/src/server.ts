import express from "express";
import { fileURLToPath } from "node:url";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/logger.js";
import { requestMetrics } from "./middleware/metrics.js";
import { connectRedis } from "./lib/redis.js";
import { pool } from "./lib/db.js";
import healthRoutes from "./routes/health.js";
import metricsRoutes from "./routes/metrics.js";
import compareRoutes, { compareEnabled } from "./routes/compare.js";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(requestLogger);
app.use(requestMetrics);
app.use("/health", healthRoutes);
app.use("/metrics", metricsRoutes);
// Version comparison (#23, D21): off unless FEATURE_VERSION_COMPARE=1
if (compareEnabled(process.env)) app.use("/api/v1/documents", compareRoutes);
app.use((req, res) => res.status(404).json({ error: "Not Found" }));
app.use(errorHandler);

// Start listening only when this file is the entry point. Tests import `app`
// and attach Supertest to it instead, so no port is taken.
const isEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntry) {
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => console.log(`api listening on ${port}`));

  // Listen first, then connect to Redis in the background (#65). If Redis is
  // down when the pod starts, the process stays up: /health answers 503 at
  // once so readiness keeps traffic away, liveness (the socket) passes, and
  // the client keeps retrying until Redis is back, without a restart loop.
  // With node-redis's default retry strategy connect() keeps retrying and
  // does not reject; the catch is kept for a strategy that gives up. Nothing
  // reconnects after that and liveness still passes, so the pod would stay
  // unready until it is restarted by hand: the log says so.
  const connectInBackground = async () => {
    try {
      await connectRedis();
    } catch (err) {
      console.error(
        "redis: client stopped retrying; /health reports Redis down until the API restarts:",
        (err as Error).message,
      );
    }
  };
  void connectInBackground();

  // On SIGTERM (Compose stop, Kubernetes rolling update) stop taking new
  // connections, let in-flight requests finish, then close the pool.
  process.on("SIGTERM", () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}

export default app;
