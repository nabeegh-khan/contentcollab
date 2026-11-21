import express from "express";
import { fileURLToPath } from "node:url";
import { errorBody, errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/logger.js";
import { requestMetrics } from "./middleware/metrics.js";
import { redis } from "./lib/redis.js";
import { pool } from "./lib/db.js";
import { HTTP_NOT_FOUND } from "./lib/httpStatus.js";
import { logListening, logRedisGaveUp } from "./lib/startup.js";
import healthRoutes from "./routes/health.js";
import metricsRoutes from "./routes/metrics.js";
import { validateStorageConfig } from "./lib/storage.js";
import { statusRoutes } from "./routes/status.js";
import { latencyFrom, queueDepth } from "./lib/status.js";
import { cachedFor, inClusterGet, readyReplicas } from "./lib/replicas.js";
import { httpDuration } from "./lib/metrics.js";
import authRoutes from "./routes/auth.js";
import commentsRoutes from "./routes/comments.js";
import { jwtSecret } from "./middleware/requireAuth.js";
import compareRoutes, { compareEnabled } from "./routes/compare.js";
import { createServer } from "node:http";
import { createSocketServer } from "./lib/socket.js";
import sharesRoutes from "./routes/shares.js";
import linksRoutes from "./routes/links.js";
import authRoutes from "./routes/auth.js";
import documentRoutes from "./routes/documents.js";
import versionsRoutes from "./routes/versions.js";

const app = express();

// The logger and the metrics come first, so a request the body parser rejects
// is still logged with an ID and counted
app.use(requestLogger);
app.use(requestMetrics);
app.use(express.json({ limit: "1mb" }));
app.use("/health", healthRoutes);
app.use("/metrics", metricsRoutes);
// Status page numbers (#30, D23); replicas come from the Kubernetes API in a pod, null elsewhere
const kubeGet = inClusterGet(process.env);
// The endpoint is public: at most one apiserver read every few seconds per pod
const REPLICAS_CACHE_MS = 5000;
const replicas = kubeGet ? cachedFor(REPLICAS_CACHE_MS, () => readyReplicas(kubeGet)) : null;
app.use(
  "/api/v1/status",
  statusRoutes({
    // Fail fast while Redis is down instead of queueing commands until the time limit
    queue: () => (redis.isReady ? queueDepth(redis) : Promise.reject(new Error("redis not ready"))),
    latency: () => latencyFrom(httpDuration),
    replicas: () => (replicas ? replicas() : Promise.resolve(null)),
  }),
);
app.use("/api/v1/auth", authRoutes);
// Version comparison (#23, D21): off unless FEATURE_VERSION_COMPARE=1
if (compareEnabled(process.env)) app.use("/api/v1/documents", compareRoutes);

app.use("/api/v1", commentsRoutes);

app.use("/api/v1/documents/:documentId/shares", sharesRoutes);
app.use("/api/v1/links", linksRoutes);
app.use("/api/v1/auth", authRoutes);

app.use("/api/v1/documents", documentRoutes);
app.use("/api/v1/documents/:documentId/versions", versionsRoutes);
app.use((req, res) => res.status(HTTP_NOT_FOUND).json(errorBody(HTTP_NOT_FOUND)));
app.use(errorHandler);

// Start listening only when this file is the entry point. Tests import `app` and attach Supertest to it instead, so no port is taken.
const isEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntry) {
  jwtSecret();
  const port = Number(process.env.PORT ?? 3000);
  validateStorageConfig();

  const server = createServer(app);
  const socketServer = createSocketServer(server);

  server.listen(port, () => logListening(port));

  // Connect Redis publisher and Socket.IO subscriber in the background.
  const connectInBackground = async () => {
    try {
      await socketServer.connectRedisClients();
    } catch (err) {
      logRedisGaveUp(err);
    }
  };
  void connectInBackground();

  // Gracefully close Socket.IO, Redis subscriber and PostgreSQL.
  process.on("SIGTERM", () => {
    void (async () => {
      await socketServer.close();
      await pool.end();
      process.exit(0);
    })();
  });
}

export default app;
