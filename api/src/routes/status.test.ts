import { describe, expect, it } from "@jest/globals";
import express from "express";
import request from "supertest";
import { statusRoutes } from "./status.js";

// GET /api/v1/status (#30): one JSON document for the status page. Sources are injected, so no
// Redis or cluster is needed; a source that fails is reported as null with the reason, and the
// endpoint still answers 200.
const OK = 200;
const WAITING = 4;
const REQUESTS = 10;
const P50 = 0.005;
const P95 = 0.1;
const API_PODS = 2;
const LATENCY = { requests: REQUESTS, p50Seconds: P50, p95Seconds: P95, overTopBucket: false };

const appWith = (deps: Parameters<typeof statusRoutes>[0]) =>
  express().use("/api/v1/status", statusRoutes(deps));

describe("GET /api/v1/status", () => {
  it("reports queue depth, latency and replicas", async () => {
    const res = await request(
      appWith({
        queue: async () => WAITING,
        latency: async () => LATENCY,
        replicas: async () => ({ api: API_PODS }),
      }),
    ).get("/api/v1/status");
    expect(res.status).toBe(OK);
    expect(res.body).toMatchObject({
      queue: { waiting: WAITING },
      latency: { ...LATENCY, scope: "this API pod" },
      replicas: { api: API_PODS },
    });
    expect(typeof res.body.generatedAt).toBe("string");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("a failing source is null with its reason, and the rest still answers", async () => {
    const res = await request(
      appWith({
        queue: async () => {
          throw new Error("redis down");
        },
        latency: async () => LATENCY,
        replicas: async () => null,
      }),
    ).get("/api/v1/status");
    expect(res.status).toBe(OK);
    // The reason a caller sees is generic; the detail goes to the log
    expect(res.body.queue).toEqual({ waiting: null, error: "unavailable" });
    expect(res.body.replicas).toEqual({ api: null });
    expect(res.body.latency.requests).toBe(LATENCY.requests);
  });

  it("a source that never answers (Redis down queues commands) is cut off, not waited for", async () => {
    const SHORT_MS = 50;
    const res = await request(
      express().use(
        "/api/v1/status",
        statusRoutes(
          {
            queue: () => new Promise<number>(() => {}),
            latency: async () => LATENCY,
            replicas: async () => null,
          },
          SHORT_MS,
        ),
      ),
    ).get("/api/v1/status");
    expect(res.status).toBe(OK);
    expect(res.body.queue).toEqual({ waiting: null, error: `no answer within ${SHORT_MS} ms` });
  });
});
