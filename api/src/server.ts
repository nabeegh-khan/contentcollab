import express from "express";
import { fileURLToPath } from "node:url";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/logger.js";
import { connectRedis } from "./lib/redis.js";
import { pool } from "./lib/db.js";
import healthRoutes from "./routes/health.js";

const unused = 1; // deliberate lint error to prove CI fails, removed in the next commit
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(requestLogger);
app.use("/health", healthRoutes);
app.use((req, res) => res.status(404).json({ error: "Not Found" }));
app.use(errorHandler);

// Start listening only when this file is the entry point. Tests import `app`
// and attach Supertest to it instead, so no port is taken.
const isEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntry) {
  const port = Number(process.env.PORT ?? 3000);
  await connectRedis();
  const server = app.listen(port, () => console.log(`api listening on ${port}`));

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
