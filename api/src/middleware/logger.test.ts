import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import express, { Router } from "express";
import request from "supertest";
import {
  HTTP_CREATED,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAVAILABLE,
} from "../lib/httpStatus.js";
import { captureStdout } from "../lib/logCapture.js";
import { errorHandler } from "./errorHandler.js";
import { requestLogger } from "./logger.js";
// The error-rate check of the demo (ARCHITECTURE D18) reads these lines: a renamed field must fail here
// @ts-expect-error a plain .mjs script with no type declarations
import { parseRequestLines } from "../../../scripts/error-rate.mjs";

// A small app with the same middleware order as server.ts, so these tests need
// neither PostgreSQL nor Redis.
function buildApp() {
  const app = express();
  app.use(requestLogger);
  app.use(express.json());

  const health = Router();
  health.get("/", (req, res) =>
    res.status(req.query.fail ? HTTP_UNAVAILABLE : HTTP_OK).json({ status: "x" }),
  );
  app.use("/health", health);

  app.get("/items/:id", (req, res) => res.json({ id: req.params.id }));
  app.post("/items", (req, res) => res.status(HTTP_CREATED).json({ ok: true }));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.use((req, res) => res.status(HTTP_NOT_FOUND).json({ error: "Not Found" }));
  app.use(errorHandler);
  return app;
}

// Accepts a version-4-style UUID in lower case.
// Matches "3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9c"; rejects "web-7f3a.1" and "".
// Try it: https://regex101.com/?regex=%5E%5B0-9a-f%5D%7B8%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B12%7D%24
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One more character than an incoming request ID may have
const MAX_ID_LENGTH = 128;
const TOO_LONG_ID = "a".repeat(MAX_ID_LENGTH + 1);

let out: ReturnType<typeof captureStdout>;
beforeEach(() => {
  delete process.env.LOG_LEVEL;
  out = captureStdout();
});
afterEach(() => {
  out.restore();
  delete process.env.LOG_LEVEL;
});

describe("request log line", () => {
  it("is one JSON line with the fields Datadog reads", async () => {
    await request(buildApp()).get("/items/42").expect(HTTP_OK);

    const lines = out.lines().filter((l) => l.msg === "request");
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    // A timestamp that survives a round trip through Date is a full ISO 8601 UTC string
    expect(new Date(line.timestamp ?? "").toISOString()).toBe(line.timestamp);
    expect(line.level).toBe("info");
    expect(line.http?.method).toBe("GET");
    expect(line.http?.route).toBe("/items/:id");
    expect(line.http?.status_code).toBe(HTTP_OK);
    expect(typeof line.http?.request_id).toBe("string");
    expect(typeof line.duration_ms).toBe("number");
    expect(line.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("writes only JSON lines to standard output", async () => {
    await request(buildApp()).get("/items/1");
    await request(buildApp()).get("/nope");
    await request(buildApp()).get("/boom");
    expect(() => out.lines()).not.toThrow();
    expect(out.lines().length).toBeGreaterThan(0);
  });

  it("logs the route template, not the path or the query string", async () => {
    await request(buildApp()).get("/items/42?token=linktoken").expect(HTTP_OK);
    const text = out.raw();
    expect(text).toContain('"/items/:id"');
    expect(text).not.toContain("/items/42");
    expect(text).not.toContain("linktoken");
  });

  it("does not log headers, cookies or bodies", async () => {
    await request(buildApp())
      .post("/items")
      .set("Authorization", "Bearer s3cr3t-bearer")
      .set("Cookie", "session=cookie-value-123")
      .send({ password: "hunter2" })
      .expect(HTTP_CREATED);
    const text = out.raw();
    ["s3cr3t-bearer", "cookie-value-123", "hunter2", "Bearer"].forEach((secret) =>
      expect(text).not.toContain(secret),
    );
    // Not vacuous: the request was logged
    expect(out.lines().some((l) => l.msg === "request")).toBe(true);
  });

  it("writes no aborted line for a request that finished", async () => {
    await request(buildApp()).get("/items/1").expect(HTTP_OK);
    // The close event follows finish by a tick
    await new Promise((resolve) => setImmediate(resolve));
    expect(out.lines().filter((l) => l.msg === "request aborted")).toEqual([]);
  });

  it("is read by the error-rate check as the same route and status", async () => {
    await request(buildApp()).get("/items/42").expect(HTTP_OK);
    await request(buildApp()).get("/boom");
    expect(parseRequestLines(out.raw())).toEqual([
      { route: "/items/:id", status: HTTP_OK },
      { route: "/boom", status: HTTP_INTERNAL_ERROR },
    ]);
  });
});

describe("request ID", () => {
  it("is generated, returned in X-Request-Id and logged with the same value", async () => {
    const res = await request(buildApp()).get("/items/1");
    const id = res.headers["x-request-id"];
    expect(id).toMatch(UUID);
    expect(out.lines().find((l) => l.msg === "request")?.http?.request_id).toBe(id);
  });

  it("reuses a valid incoming X-Request-Id", async () => {
    const res = await request(buildApp()).get("/items/1").set("X-Request-Id", "web-7f3a.1_ok");
    expect(res.headers["x-request-id"]).toBe("web-7f3a.1_ok");
    expect(out.lines().find((l) => l.msg === "request")?.http?.request_id).toBe("web-7f3a.1_ok");
  });

  it.each([
    ["spaces", "bad id with spaces"],
    ["quotes", 'a"b'],
    ["too long", TOO_LONG_ID],
  ])("replaces an unusable incoming X-Request-Id (%s)", async (_name, value) => {
    const res = await request(buildApp()).get("/items/1").set("X-Request-Id", value);
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });
});

describe("level", () => {
  it("is info for 2xx, warn for 4xx and error for 5xx", async () => {
    await request(buildApp()).get("/items/1");
    await request(buildApp()).get("/nope");
    await request(buildApp()).get("/boom");
    const byStatus = Object.fromEntries(
      out
        .lines()
        .filter((l) => l.msg === "request")
        .map((l) => [l.http?.status_code, l.level]),
    );
    expect(byStatus).toEqual({
      [HTTP_OK]: "info",
      [HTTP_NOT_FOUND]: "warn",
      [HTTP_INTERNAL_ERROR]: "error",
    });
  });

  it("keeps a successful probe out of the log at the default level", async () => {
    await request(buildApp()).get("/health").expect(HTTP_OK);
    expect(out.lines().filter((l) => l.msg === "request")).toHaveLength(0);
  });

  it("logs a successful probe at debug when LOG_LEVEL=debug", async () => {
    process.env.LOG_LEVEL = "debug";
    await request(buildApp()).get("/health").expect(HTTP_OK);
    const line = out.lines().find((l) => l.msg === "request");
    expect(line?.level).toBe("debug");
    expect(line?.http?.route).toBe("/health");
  });

  it("logs a failing probe as an error", async () => {
    await request(buildApp()).get("/health?fail=1").expect(HTTP_UNAVAILABLE);
    const line = out.lines().find((l) => l.msg === "request");
    expect(line?.level).toBe("error");
    expect(line?.http?.status_code).toBe(HTTP_UNAVAILABLE);
  });
});
