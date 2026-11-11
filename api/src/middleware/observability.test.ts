import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import express, { Router } from "express";
import request from "supertest";
import {
  HTTP_CLASS_SIZE,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_SERVER_ERROR_MIN,
} from "../lib/httpStatus.js";
import { captureStdout } from "../lib/logCapture.js";
import { registry } from "../lib/metrics.js";
import { statusClass } from "../lib/routeLabel.js";
import { errorHandler } from "./errorHandler.js";
import { requestLogger } from "./logger.js";
import { requestMetrics } from "./metrics.js";

// Route labels, durations and aborted requests, through the same middleware
// order as server.ts.
const SLOW_MS = 60;
// Timers can fire a little early on a busy machine
const TIMER_SLACK_MS = 20;
const MAX_SLOW_REQUEST_MS = 5000;

// The aborted-request test waits on these events, not on fixed delays, so a
// busy CI runner cannot make it flaky: the client gives up once the handler
// has the request, and the test reads the log once the server saw the close.
const slowEvents = { entered: () => {}, closed: () => {} };
// "/rx/*" and the "/a1" and "/a2" pair: two routes, so two labels
const EXPECTED_ROUTE_LABELS = 2;

// Matches a path starting with "/rx/": "/rx/one" matches; "/other/rx/one" does not.
// Try it: https://regex101.com/?regex=%5E%5C%2Frx%5C%2F.*%24
const RX_ROUTE = /^\/rx\/.*$/;

function buildApp() {
  const app = express();
  app.use(requestLogger);
  app.use(requestMetrics);

  const health = Router();
  health.get("/", (req, res) => res.json({ status: "ok" }));
  health.get("/err", () => {
    throw new Error("kaboom");
  });
  app.use("/health", health);

  app.get(RX_ROUTE, (req, res) => res.json({ ok: true }));
  app.get(["/a1", "/a2"], (req, res) => res.json({ ok: true }));
  app.get("/slow", (req, res) => {
    // Registered after the logger's own close listener, so the log line is written first
    res.on("close", () => slowEvents.closed());
    slowEvents.entered();
    setTimeout(() => {
      if (!res.destroyed) res.json({ ok: true });
    }, SLOW_MS);
  });
  app.use((req, res) => res.status(HTTP_NOT_FOUND).json({ error: "Not Found" }));
  app.use(errorHandler);
  return app;
}

type Sample = { value: number; labels: Record<string, string | number> };
async function samples(name: string): Promise<Sample[]> {
  const all = await registry.getMetricsAsJSON();
  return (all.find((m) => m.name === name)?.values ?? []) as Sample[];
}

let out: ReturnType<typeof captureStdout>;
beforeEach(() => {
  out = captureStdout();
  registry.resetMetrics();
});
afterEach(() => {
  out.restore();
});

describe("route label", () => {
  it("does not depend on the case of the URL", async () => {
    const app = buildApp();
    await request(app).get("/HEALTH");
    await request(app).get("/HeAlTh");
    await request(app).get("/health");
    const routes = new Set((await samples("http_requests_total")).map((s) => s.labels.route));
    expect(routes).toEqual(new Set(["/health"]));
    const durationRoutes = new Set(
      (await samples("http_request_duration_seconds")).map((s) => s.labels.route),
    );
    expect(durationRoutes).toEqual(new Set(["/health"]));
  });

  it("keeps the mount path when an error is thrown in a route under a router", async () => {
    await request(buildApp()).get("/health/err");
    const failed = out.lines().find((l) => l.msg === "request failed");
    const done = out.lines().find((l) => l.msg === "request");
    expect(failed?.http?.route).toBe("/health/err");
    expect(done?.http?.route).toBe("/health/err");
    const [errors] = await samples("http_errors_total");
    expect(errors?.labels.route).toBe("/health/err");
  });

  it("labels a route registered with a regular expression or an array, not unmatched", async () => {
    const app = buildApp();
    await request(app).get("/rx/one");
    await request(app).get("/rx/two");
    await request(app).get("/a1");
    await request(app).get("/a2");
    const routes = new Set((await samples("http_requests_total")).map((s) => s.labels.route));
    expect(routes.has("unmatched")).toBe(false);
    expect(routes.size).toBe(EXPECTED_ROUTE_LABELS);
  });

  it("labels the latency histogram with method and route only", async () => {
    await request(buildApp()).get("/health");
    const [only] = await samples("http_request_duration_seconds");
    expect(Object.keys(only?.labels ?? {}).sort()).toEqual(["le", "method", "route"]);
  });
});

describe("duration_ms", () => {
  it("is in milliseconds: a handler that takes 60 ms logs about 60", async () => {
    await request(buildApp()).get("/slow").expect(HTTP_OK);
    const line = out.lines().find((l) => l.msg === "request");
    expect(line?.duration_ms).toBeGreaterThanOrEqual(SLOW_MS - TIMER_SLACK_MS);
    expect(line?.duration_ms).toBeLessThan(MAX_SLOW_REQUEST_MS);
  });
});

describe("a request the client abandons", () => {
  it("is logged as aborted instead of vanishing", async () => {
    const server = buildApp().listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const serverSawClose = new Promise<void>((resolve) => {
        slowEvents.closed = resolve;
      });
      const req = httpRequest({ port, path: "/slow", host: "127.0.0.1" });
      req.on("error", () => {});
      slowEvents.entered = () => req.destroy();
      req.end();
      await serverSawClose;
    } finally {
      slowEvents.entered = () => {};
      slowEvents.closed = () => {};
      await new Promise((resolve) => server.close(resolve));
    }
    const line = out.lines().find((l) => l.msg === "request aborted");
    expect(line?.level).toBe("warn");
    expect(line?.http?.route).toBe("/slow");
    expect(line?.http?.request_id).toBeDefined();
    expect(out.lines().some((l) => l.msg === "request")).toBe(false);
    // Decided, not accidental: a request the client gave up on has no status, so the
    // request counters skip it; the log line above is where it shows (D16)
    expect(await samples("http_requests_total")).toEqual([]);
  });
});

describe("statusClass", () => {
  it("puts a status in the class of its hundred, never rounding up", () => {
    expect(statusClass(HTTP_OK - 1)).toBe("1xx");
    expect(statusClass(HTTP_OK)).toBe("2xx");
    expect(statusClass(HTTP_NOT_FOUND)).toBe("4xx");
    expect(statusClass(HTTP_SERVER_ERROR_MIN - 1)).toBe("4xx");
    expect(statusClass(HTTP_INTERNAL_ERROR)).toBe("5xx");
    expect(statusClass(HTTP_SERVER_ERROR_MIN + HTTP_CLASS_SIZE - 1)).toBe("5xx");
  });
});
