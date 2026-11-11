import { beforeEach, describe, expect, it } from "@jest/globals";
import express, { Router } from "express";
import request from "supertest";
import { HTTP_INTERNAL_ERROR, HTTP_NOT_FOUND, HTTP_OK } from "../lib/httpStatus.js";
import { registry } from "../lib/metrics.js";
import { errorHandler } from "./errorHandler.js";
import { requestMetrics } from "./metrics.js";

function buildApp() {
  const app = express();
  app.use(requestMetrics);
  const health = Router();
  health.get("/", (req, res) => res.json({ status: "ok" }));
  app.use("/health", health);
  app.get("/items/:id", (req, res) => res.json({ id: req.params.id }));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.use((req, res) => res.status(HTTP_NOT_FOUND).json({ error: "Not Found" }));
  app.use(errorHandler);
  return app;
}

type Sample = { value: number; labels: Record<string, string | number> };
async function samples(name: string): Promise<Sample[]> {
  const all = await registry.getMetricsAsJSON();
  const metric = all.find((m) => m.name === name);
  return (metric?.values ?? []) as Sample[];
}

// How many different paths a client sends in the cardinality test
const DISTINCT_PATHS = 25;
// Two routes only: the item template and "unmatched"
const EXPECTED_SERIES = 2;

beforeEach(() => {
  registry.resetMetrics();
});

describe("http_requests_total", () => {
  it("carries method, route and status_class, and nothing else", async () => {
    await request(buildApp()).get("/items/7").expect(HTTP_OK);
    const [only, ...rest] = await samples("http_requests_total");
    expect(rest).toHaveLength(0);
    expect(only?.labels).toEqual({ method: "GET", route: "/items/:id", status_class: "2xx" });
    expect(only?.value).toBe(1);
  });

  it("uses the route template for a router mounted on a path, without a trailing slash", async () => {
    await request(buildApp()).get("/health").expect(HTTP_OK);
    const [only] = await samples("http_requests_total");
    expect(only?.labels.route).toBe("/health");
  });

  it("keeps the number of series bounded however many paths clients send", async () => {
    const app = buildApp();
    const paths = Array.from({ length: DISTINCT_PATHS }, (_, i) => i);
    await Promise.all(
      paths.flatMap((i) => [request(app).get(`/items/${i}`), request(app).get(`/no-such-${i}`)]),
    );
    const series = await samples("http_requests_total");
    expect(new Set(series.map((s) => s.labels.route))).toEqual(
      new Set(["/items/:id", "unmatched"]),
    );
    expect(series.length).toBeLessThanOrEqual(EXPECTED_SERIES);
  });
});

describe("http_errors_total", () => {
  it("counts a 5xx with method, route and status_class", async () => {
    await request(buildApp()).get("/boom").expect(HTTP_INTERNAL_ERROR);
    const [only, ...rest] = await samples("http_errors_total");
    expect(rest).toHaveLength(0);
    expect(only?.labels).toEqual({ method: "GET", route: "/boom", status_class: "5xx" });
  });

  it("does not count a 4xx", async () => {
    await request(buildApp()).get("/no-such-path").expect(HTTP_NOT_FOUND);
    expect(await samples("http_errors_total")).toHaveLength(0);
    const [only] = await samples("http_requests_total");
    expect(only?.labels.status_class).toBe("4xx");
  });
});
