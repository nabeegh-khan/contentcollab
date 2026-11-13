import { createServer } from "node:http";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAME } from "./queue.js";
import { connection } from "./redis.js";
import { ping, type PingData } from "./jobs/ping.js";
import { versionDiff, type VersionDiffData } from "./jobs/versionDiff.js";

// Handlers by job name. Adding a job type is one entry here plus a file in
// jobs/, nothing else changes (D10: extend behind the contract).
// Defaults when the environment sets nothing, and the HTTP codes the probe answers with
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_HEALTH_PORT = 3001;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

const handlers: Record<string, (job: Job) => Promise<unknown>> = {
  ping: (job) => ping(job as Job<PingData>),
  "version-diff": (job) => versionDiff(job as Job<VersionDiffData>),
};

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const handler = handlers[job.name];
    if (!handler) {
      throw new Error(`no handler for job "${job.name}"`);
    }
    return handler(job);
  },
  {
    connection,
    // Few jobs at once: each one may hold a file or a model call in memory
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? DEFAULT_CONCURRENCY),
  },
);

worker.on("completed", (job) => console.log(`${job.name} ${job.id} completed`));
worker.on("failed", (job, err) => console.error(`${job?.name} ${job?.id} failed: ${err.message}`));

// Readiness for Compose and Kubernetes: 200 while the worker is running and
// Redis answers, 503 otherwise. Not a public endpoint.
const port = Number(process.env.WORKER_PORT ?? DEFAULT_HEALTH_PORT);
// A separate client for the probe, so a blocked queue read never delays it
const probe = new Redis({ ...connection, lazyConnect: true });
const health = createServer(async (req, res) => {
  if (req.url !== "/health") {
    res.writeHead(HTTP_NOT_FOUND).end();
    return;
  }
  try {
    const ok = worker.isRunning() && (await probe.ping()) === "PONG";
    res.writeHead(ok ? HTTP_OK : HTTP_UNAVAILABLE, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: ok ? "ok" : "degraded" }));
  } catch {
    res.writeHead(HTTP_UNAVAILABLE).end();
  }
});
health.listen(port, () => console.log(`worker health on ${port}`));

// On SIGTERM finish the job in hand, then exit, so a rolling update or a
// scale-down never drops a job halfway (API-7).
process.on("SIGTERM", async () => {
  health.close();
  await worker.close();
  probe.disconnect();
  process.exit(0);
});
