import { describe, expect, it } from "@jest/globals";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { errorHandler } from "../middleware/errorHandler.js";
import { opsRoutes, type OpsSources } from "./ops.js";

// GET /api/v1/ops (D31): sign-in and an admin check on the whole router, each source on its own, one
// snapshot per few seconds. Sources are injected, so no cluster, Prometheus or database is needed.
const SECRET = "test-secret-for-ops";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OK = 200;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
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
    noTraffic: false,
  }),
  claim: async () => ({
    name: "data-postgres-0",
    phase: "Bound",
    capacity: "5Gi",
    storageClass: "do-block-storage",
  }),
  counts: async () => ({ documents: 12, versions: 19 }),
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
      storage: { claim: { phase: "Bound" }, documents: 12, versions: 19 },
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
      claim: expect.objectContaining({ phase: "Bound" }),
      documents: null,
      versions: null,
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
