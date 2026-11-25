import { describe, expect, it } from "@jest/globals";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { errorHandler } from "../middleware/errorHandler.js";
import { DrillRateLimited } from "../lib/ops/drill.js";
import { opsRoutes, type OpsSources } from "./ops.js";

// GET /api/v1/ops (D31): sign-in and an admin check on the whole router, each source on its own, one
// snapshot per few seconds. Sources are injected, so no cluster, Prometheus or database is needed.
const SECRET = "test-secret-for-ops";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OK = 200;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CACHE_MS = 5000;
const env = { OPS_ADMIN_USER_IDS: ADMIN };

const token = (sub: string) => jwt.sign({ sub }, SECRET, { algorithm: "HS256" });

const sources = (over: Partial<OpsSources> = {}): OpsSources => ({
  containers: async () => [
    {
      component: "api",
      pod: "api-a",
      status: "Running",
      ready: true,
      node: "n1",
      restarts: 0,
      startedAt: "2026-11-21T19:23:20Z",
      ageSeconds: 1000,
      lastRestartAt: null,
      servingThisRequest: true,
    },
  ],
  hpa: async () => ({
    name: "api",
    currentReplicas: 2,
    desiredReplicas: 2,
    minReplicas: 2,
    maxReplicas: 5,
    cpuPercent: 12,
    cpuTargetPercent: 70,
    lastScaleTime: null,
    limitedBy: "TooFewReplicas",
  }),
  nodes: async () => [],
  traffic: async () => ({
    windowSeconds: 60,
    requestsPerSecond: 0.4,
    p50Seconds: 0.006,
    p95Seconds: 0.012,
    errorPercent: 0,
    errorPercent5m: 0,
    noTraffic: false,
  }),
  claim: async () => ({
    name: "data-postgres-0",
    phase: "Bound",
    capacity: "5Gi",
    storageClass: "do-block-storage",
    volumeName: "pvc-6a857bd4",
  }),
  counts: async () => ({ documents: 12, versions: 19, comments: 7 }),
  events: async () => [],
  logs: async () => ({ lines: [], hidden: 0 }),
  ...over,
});

function appWith(src: OpsSources, now = () => 0) {
  process.env.JWT_SECRET = SECRET;
  const app = express();
  app.use("/api/v1/ops", opsRoutes(src, { env, ttlMs: CACHE_MS, now, grafanaUrl: null }));
  app.use(errorHandler);
  return app;
}

describe("GET /api/v1/ops access", () => {
  it("is 401 without a token", async () => {
    const res = await request(appWith(sources())).get("/api/v1/ops");
    expect(res.status).toBe(UNAUTHORIZED);
  });

  it("is 403 for a signed-in user who is not an admin, and reads nothing", async () => {
    let reads = 0;
    const src = sources({
      containers: async () => {
        reads += 1;
        return [];
      },
    });
    const res = await request(appWith(src))
      .get("/api/v1/ops")
      .set("Authorization", `Bearer ${token(OTHER)}`);
    expect(res.status).toBe(FORBIDDEN);
    expect(reads).toBe(0);
  });

  it("every route of the router refuses a missing token and a non-admin", async () => {
    const router = opsRoutes(sources(), { env, ttlMs: CACHE_MS, now: () => 0, grafanaUrl: null });
    const layers = router.stack.filter((layer) => layer.route);
    expect(layers.length).toBeGreaterThan(0);
    const app = appWith(sources());
    const checks = layers.flatMap((layer) => {
      const route = layer.route as unknown as { methods: Record<string, boolean>; path: string };
      const method = Object.keys(route.methods)[0] as "get" | "post";
      const path = `/api/v1/ops${route.path === "/" ? "" : route.path}`;
      return [
        request(app)
          [method](path)
          .then((r) => r.status),
        request(app)
          [method](path)
          .set("Authorization", `Bearer ${token(OTHER)}`)
          .then((r) => r.status),
      ];
    });
    expect(await Promise.all(checks)).toEqual(layers.flatMap(() => [UNAUTHORIZED, FORBIDDEN]));
  });
});

describe("GET /api/v1/ops document", () => {
  const get = (app: express.Express) =>
    request(app)
      .get("/api/v1/ops")
      .set("Authorization", `Bearer ${token(ADMIN)}`);

  it("returns every card, uncached by the browser", async () => {
    const res = await get(appWith(sources()));
    expect(res.status).toBe(OK);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      cachedForSeconds: 5,
      namespace: "contentcollab",
      errors: {},
      containers: [{ component: "api", pod: "api-a" }],
      hpa: { currentReplicas: 2, cpuTargetPercent: 70 },
      nodes: [],
      traffic: { requestsPerSecond: 0.4 },
      storage: { claim: { phase: "Bound" }, documents: 12, versions: 19, comments: 7 },
      events: [],
      logs: { lines: [], hidden: 0 },
      drills: { nextAllowedAt: null },
      links: { grafana: null },
    });
    expect(typeof res.body.generatedAt).toBe("string");
  });

  it("a failing source is null with its reason, and the rest still answers 200", async () => {
    const res = await get(
      appWith(
        sources({
          traffic: async () => {
            throw new Error("connect ECONNREFUSED 10.0.0.9:9090");
          },
        }),
      ),
    );
    expect(res.status).toBe(OK);
    expect(res.body.traffic).toBeNull();
    expect(res.body.errors).toEqual({ traffic: "unavailable" });
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
    expect(res.body.containers).not.toBeNull();
  });

  it("a source that is not configured says so", async () => {
    const res = await get(appWith(sources({ traffic: null, containers: null })));
    expect(res.body.errors).toMatchObject({
      traffic: "not configured",
      containers: "not configured",
    });
    expect(res.body.traffic).toBeNull();
  });

  it("gives the worker queue's waiting jobs, and a reason when the queue cannot be read (#30)", async () => {
    const ok = await get(appWith(sources({ queue: async () => 3 })));
    expect((await get(appWith(sources({ queue: async () => 0 })))).body.queue).toEqual({
      depth: 0,
    });
    expect(ok.body.queue).toEqual({ depth: 3 });
    expect(ok.body.errors).toEqual({});
    const failed = await get(
      appWith(
        sources({
          queue: async () => {
            throw new Error("redis down");
          },
        }),
      ),
    );
    expect(failed.body.queue).toEqual({ depth: null });
    expect(failed.body.errors).toEqual({ queue: "unavailable" });
    expect(JSON.stringify(failed.body)).not.toContain("redis down");
  });

  it("gives the serverless function card, and a reason when the list cannot be read (D39)", async () => {
    const [CALL_MS, COMPUTE_MS, INPUT_BYTES] = [120, 4.2, 900];
    const invocation = {
      at: "2026-11-25T15:00:00.000Z",
      outcome: "function" as const,
      ms: CALL_MS,
      computeMs: COMPUTE_MS,
      inputBytes: INPUT_BYTES,
      reason: null,
    };
    const ok = await get(
      appWith(
        sources({ functions: async () => ({ configured: true, invocations: [invocation] }) }),
      ),
    );
    expect(ok.body.functions).toEqual({ configured: true, invocations: [invocation] });
    const failed = await get(
      appWith(
        sources({
          functions: async () => {
            throw new Error("redis down");
          },
        }),
      ),
    );
    expect(failed.body.functions).toBeNull();
    expect(failed.body.errors).toEqual({ functions: "unavailable" });
    expect(JSON.stringify(failed.body)).not.toContain("redis down");
  });

  it("has no function card where no source is given", async () => {
    const res = await get(appWith(sources()));
    expect(res.body.functions).toBeNull();
    expect(res.body.errors).toEqual({});
  });

  it("has no queue figure where no queue source is given", async () => {
    const res = await get(appWith(sources()));
    expect(res.body.queue).toEqual({ depth: null });
    expect(res.body.errors).toEqual({});
  });

  it("claim and counts fail separately", async () => {
    const res = await get(
      appWith(
        sources({
          counts: async () => {
            throw new Error("db down");
          },
        }),
      ),
    );
    expect(res.body.storage).toEqual({
      volume: null,
      backup: null,
      diskUsedPercent: null,
      claim: expect.objectContaining({ phase: "Bound" }),
      documents: null,
      versions: null,
      comments: null,
    });
    expect(res.body.errors).toEqual({ counts: "unavailable" });
  });

  it("a source that does not answer in time is reported with the time limit", async () => {
    process.env.JWT_SECRET = SECRET;
    const app = express();
    app.use(
      "/api/v1/ops",
      opsRoutes(sources({ hpa: () => new Promise(() => {}) }), {
        env,
        ttlMs: CACHE_MS,
        now: () => 0,
        grafanaUrl: null,
        timeoutMs: 20,
      }),
    );
    app.use(errorHandler);
    const res = await get(app);
    expect(res.body.hpa).toBeNull();
    expect(res.body.errors.hpa).toBe("no answer within 20 ms");
  });

  it("builds one snapshot per window, however many callers", async () => {
    let reads = 0;
    let clock = 0;
    const app = appWith(
      sources({
        events: async () => {
          reads += 1;
          return [];
        },
      }),
      () => clock,
    );
    await Promise.all([get(app), get(app), get(app)]);
    expect(reads).toBe(1);
    clock = CACHE_MS + 1;
    await get(app);
    expect(reads).toBe(2);
  });

  it("tells the client when the next drill is allowed", async () => {
    const res = await get(appWith(sources({ nextDrill: async () => "2026-11-21T19:42:02.000Z" })));
    expect(res.body.drills).toEqual({ nextAllowedAt: "2026-11-21T19:42:02.000Z" });
  });

  it("links Grafana only when it is configured", async () => {
    process.env.JWT_SECRET = SECRET;
    const app = express();
    app.use(
      "/api/v1/ops",
      opsRoutes(sources(), { env, ttlMs: CACHE_MS, now: () => 0, grafanaUrl: "https://g.example" }),
    );
    app.use(errorHandler);
    const res = await get(app);
    expect(res.body.links).toEqual({ grafana: "https://g.example" });
  });
});

describe("POST /api/v1/ops/drills", () => {
  const post = (app: express.Express, body: unknown, sub = ADMIN) =>
    request(app)
      .post("/api/v1/ops/drills")
      .set("Authorization", `Bearer ${token(sub)}`)
      .send(body as object);

  function appWithDrill(run: (target: "api" | "postgres", actor: string) => Promise<object>) {
    process.env.JWT_SECRET = SECRET;
    const app = express();
    app.use(express.json());
    app.use(
      "/api/v1/ops",
      opsRoutes(sources(), { env, ttlMs: CACHE_MS, now: () => 0, grafanaUrl: null, drill: run }),
    );
    app.use(errorHandler);
    return app;
  }

  it("runs the drill for the signed-in admin and answers with the pod and the next time allowed", async () => {
    const seen: [string, string][] = [];
    const app = appWithDrill(async (target, actor) => {
      seen.push([target, actor]);
      return { target, pod: "api-old", startedAt: "t", nextAllowedAt: "t2" };
    });
    const res = await post(app, { target: "api" });
    expect(res.status).toBe(OK);
    expect(res.body).toEqual({
      target: "api",
      pod: "api-old",
      startedAt: "t",
      nextAllowedAt: "t2",
    });
    expect(seen).toEqual([["api", ADMIN]]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("accepts only the two targets, so the client can never name a pod", async () => {
    let ran = 0;
    const app = appWithDrill(async () => {
      ran += 1;
      return {};
    });
    for (const body of [
      { target: "worker" },
      { target: "api", pod: "postgres-0" },
      {},
      { target: ["api"] },
    ]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
    }
    expect(ran).toBe(0);
  });

  it("passes a rate limit through as 429 with Retry-After", async () => {
    const app = appWithDrill(async () => {
      throw new DrillRateLimited(37);
    });
    const res = await post(app, { target: "api" });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("37");
  });

  it("is 403 for a non-admin and runs nothing", async () => {
    let ran = 0;
    const app = appWithDrill(async () => {
      ran += 1;
      return {};
    });
    const res = await post(app, { target: "api" }, OTHER);
    expect(res.status).toBe(FORBIDDEN);
    expect(ran).toBe(0);
  });

  it("is 404 when drills are not configured here (not in a cluster)", async () => {
    const res = await post(appWith(sources()), { target: "api" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/ops/series", () => {
  const getSeries = (app: express.Express, sub = ADMIN) =>
    request(app)
      .get("/api/v1/ops/series")
      .set("Authorization", `Bearer ${token(sub)}`);

  function appWithSeries(series: () => Promise<object>) {
    process.env.JWT_SECRET = SECRET;
    const app = express();
    app.use(
      "/api/v1/ops",
      opsRoutes(sources(), { env, ttlMs: CACHE_MS, now: () => 0, grafanaUrl: null, series }),
    );
    app.use(errorHandler);
    return app;
  }

  it("returns the per-pod series for an admin, uncached by the browser", async () => {
    const body = { windowSeconds: 900, stepSeconds: 15, cpu: [], memory: [] };
    const res = await getSeries(appWithSeries(async () => body));
    expect(res.status).toBe(OK);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ series: body });
  });

  it("is 401 without a token and 403 for a non-admin", async () => {
    const app = appWithSeries(async () => ({}));
    expect((await request(app).get("/api/v1/ops/series")).status).toBe(UNAUTHORIZED);
    expect((await getSeries(app, OTHER)).status).toBe(FORBIDDEN);
  });

  it("answers 200 with a reason when Prometheus cannot be read, never the error text", async () => {
    const res = await getSeries(
      appWithSeries(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.9:9090");
      }),
    );
    expect(res.status).toBe(OK);
    expect(res.body).toEqual({ series: null, error: "unavailable" });
  });

  it("reads Prometheus once per window however many callers", async () => {
    let reads = 0;
    const app = appWithSeries(async () => {
      reads += 1;
      return {};
    });
    await Promise.all([getSeries(app), getSeries(app), getSeries(app)]);
    expect(reads).toBe(1);
  });
});

describe("GET /api/v1/ops core health (D35)", () => {
  const get = (app: express.Express) =>
    request(app)
      .get("/api/v1/ops")
      .set("Authorization", `Bearer ${token(ADMIN)}`);
  const PAIR = 2;
  const DISK_PERCENT = 12.5;
  const POLICY_THRESHOLD = 80;
  const POLICY_WINDOW = 5;
  const given: Partial<OpsSources> = {
    workloads: async () => [{ component: "api", desired: PAIR, ready: PAIR }],
    volume: async () => ({
      name: "pvc-6a857bd4",
      reclaimPolicy: "Retain",
      storageClass: "do-block-storage",
      capacity: "5Gi",
    }),
    backup: async () => ({
      schedule: "0 3 * * *",
      lastScheduledAt: "2026-11-24T08:00:00Z",
      lastSucceededAt: "2026-11-24T08:00:13Z",
      lastRun: { name: "db-backup-1", result: "Succeeded", finishedAt: "2026-11-24T08:00:13Z" },
    }),
    diskUsed: async () => DISK_PERCENT,
    alerts: async () => ({
      thresholdPercent: POLICY_THRESHOLD,
      windowMinutes: POLICY_WINDOW,
      rows: [{ metric: "CPU", thresholdPercent: POLICY_THRESHOLD, valuePercent: 31 }],
    }),
  };

  it("carries the workloads, the volume, the last backup, the disk figure and the alerts table", async () => {
    const res = await get(appWith(sources(given)));
    expect(res.body.errors).toEqual({});
    expect(res.body.workloads).toEqual([{ component: "api", desired: PAIR, ready: PAIR }]);
    expect(res.body.storage.volume).toMatchObject({ reclaimPolicy: "Retain" });
    expect(res.body.storage.backup).toMatchObject({
      lastRun: { result: "Succeeded" },
      lastSucceededAt: "2026-11-24T08:00:13Z",
    });
    expect(res.body.storage.diskUsedPercent).toBe(DISK_PERCENT);
    expect(res.body.alerts).toMatchObject({ thresholdPercent: POLICY_THRESHOLD });
  });

  it("leaves them null, with no error, where a source is not given (no cluster)", async () => {
    const res = await get(appWith(sources()));
    expect(res.body.workloads).toBeNull();
    expect(res.body.alerts).toBeNull();
    expect(res.body.storage).toMatchObject({ volume: null, backup: null, diskUsedPercent: null });
    expect(res.body.errors).toEqual({});
  });

  it("each of them fails alone, with a reason and nothing from the failure text", async () => {
    const boom = async () => {
      throw new Error("forbidden: internal detail 10.0.0.9");
    };
    const res = await get(
      appWith(
        sources({
          ...given,
          workloads: boom,
          volume: boom,
          backup: boom,
          diskUsed: boom,
          alerts: boom,
        }),
      ),
    );
    expect(res.status).toBe(OK);
    expect(res.body.errors).toEqual({
      workloads: "unavailable",
      volume: "unavailable",
      backup: "unavailable",
      diskUsed: "unavailable",
      alerts: "unavailable",
    });
    expect(res.body.workloads).toBeNull();
    expect(res.body.storage.diskUsedPercent).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("internal detail");
    expect(res.body.containers).not.toBeNull();
  });

  it("a disk figure of null (no such series) is not an error: it is not measured", async () => {
    const res = await get(appWith(sources({ ...given, diskUsed: async () => null })));
    expect(res.body.storage.diskUsedPercent).toBeNull();
    expect(res.body.errors).toEqual({});
  });
});

describe("GET /api/v1/ops/sessions (D38)", () => {
  const COUNTS = {
    total: 5,
    partial: false,
    replicas: [
      { replica: "api-a", sessions: 3 },
      { replica: "api-b", sessions: 2 },
    ],
  };
  const getSessions = (app: express.Express, sub = ADMIN) =>
    request(app)
      .get("/api/v1/ops/sessions")
      .set("Authorization", `Bearer ${token(sub)}`);

  function appWithSessions(sessions?: () => Promise<object>) {
    process.env.JWT_SECRET = SECRET;
    const app = express();
    app.use(
      "/api/v1/ops",
      opsRoutes(sources(), {
        env,
        ttlMs: CACHE_MS,
        now: () => 0,
        grafanaUrl: null,
        ...(sessions ? { sessions } : {}),
      }),
    );
    app.use(errorHandler);
    return app;
  }

  it("returns the counts for an admin, uncached by the browser", async () => {
    const res = await getSessions(appWithSessions(async () => COUNTS));
    expect(res.status).toBe(OK);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ sessions: COUNTS });
  });

  it("is 401 without a token and 403 for a non-admin", async () => {
    const app = appWithSessions(async () => COUNTS);
    expect((await request(app).get("/api/v1/ops/sessions")).status).toBe(UNAUTHORIZED);
    expect((await getSessions(app, OTHER)).status).toBe(FORBIDDEN);
  });

  it("answers 200 with a reason when the count cannot be made, never the error text", async () => {
    const res = await getSessions(
      appWithSessions(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.9:6379");
      }),
    );
    expect(res.status).toBe(OK);
    expect(res.body).toEqual({ sessions: null, error: "unavailable" });
  });

  it("asks the replicas once per window however many callers", async () => {
    let asked = 0;
    const app = appWithSessions(async () => {
      asked += 1;
      return COUNTS;
    });
    await Promise.all([getSessions(app), getSessions(app), getSessions(app)]);
    expect(asked).toBe(1);
  });

  it("is 404 when no sessions source is given to the router", async () => {
    expect((await getSessions(appWithSessions())).status).toBe(NOT_FOUND);
  });
});

describe("GET /api/v1/ops/sessions window (D38)", () => {
  const WINDOW_MS = 2000;
  it("asks again once the 2 s default window has passed, not before", async () => {
    process.env.JWT_SECRET = SECRET;
    let clock = 0;
    let asked = 0;
    const app = express();
    app.use(
      "/api/v1/ops",
      opsRoutes(sources(), {
        env,
        now: () => clock,
        grafanaUrl: null,
        sessions: async () => ({ total: (asked += 1) }),
      }),
    );
    app.use(errorHandler);
    const get = () =>
      request(app)
        .get("/api/v1/ops/sessions")
        .set("Authorization", `Bearer ${token(ADMIN)}`);
    await get();
    clock = WINDOW_MS - 1;
    await get();
    expect(asked).toBe(1);
    clock = WINDOW_MS + 1;
    await get();
    expect(asked).toBe(2);
  });
});
