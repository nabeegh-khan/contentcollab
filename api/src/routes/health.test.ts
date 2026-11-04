import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import app from "../server.js";
import { pool } from "../lib/db.js";
import { connectRedis, redis } from "../lib/redis.js";

// These run against a real PostgreSQL and Redis: the services in ci.yml, or
// `docker compose up postgres redis` locally. Every endpoint adds its tests
// next to its route file, the same way.
beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe("GET /health", () => {
  it("reports 200 with PostgreSQL and Redis both up", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", postgres: "ok", redis: "ok" });
  });
});

describe("unknown routes", () => {
  it("answer 404 with the JSON error shape", async () => {
    const res = await request(app).get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not Found" });
  });
});

describe("GET /metrics", () => {
  it("exposes the request counter in Prometheus text format", async () => {
    await request(app).get("/health");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("http_requests_total");
  });
});
