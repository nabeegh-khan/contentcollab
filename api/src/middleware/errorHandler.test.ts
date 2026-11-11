import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import express, { type Request, type Response } from "express";
import request from "supertest";
import {
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_FORBIDDEN,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  HTTP_UNAVAILABLE,
  HTTP_UNPROCESSABLE,
} from "../lib/httpStatus.js";

// Not in httpStatus.ts: no route answers it; it checks the fallback code
const HTTP_IM_A_TEAPOT = 418;
import { captureStdout } from "../lib/logCapture.js";
import { registry } from "../lib/metrics.js";
import app from "../server.js";
import { errorHandler } from "./errorHandler.js";
import { requestLogger } from "./logger.js";

// A little over the 1 MB JSON body limit in server.ts
const OVER_THE_LIMIT_BYTES = 1_100_000;
// The two malformed bodies the body-leak test sends
const REJECTED_BODIES = 2;

let out: ReturnType<typeof captureStdout>;
beforeEach(() => {
  out = captureStdout();
  registry.resetMetrics();
});
afterEach(() => {
  out.restore();
});

function failingApp(error: Error) {
  const a = express();
  a.use(requestLogger);
  a.get("/fail", () => {
    throw error;
  });
  a.use(errorHandler);
  return a;
}

describe("errorHandler", () => {
  it("answers a thrown error with a fixed 500 body and no detail", async () => {
    const res = await request(failingApp(new Error("kaboom: secret detail"))).get("/fail");
    expect(res.status).toBe(HTTP_INTERNAL_ERROR);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL" });
    expect(res.text).not.toContain("kaboom");
    expect(res.text).not.toContain("at ");
  });

  it("logs the error as JSON with the request ID of the request that failed", async () => {
    const res = await request(failingApp(new Error("kaboom"))).get("/fail");
    const line = out.lines().find((l) => l.msg === "request failed");
    expect(line?.level).toBe("error");
    expect(line?.error?.kind).toBe("Error");
    expect(line?.error?.message).toBe("kaboom");
    expect(typeof line?.error?.stack).toBe("string");
    expect(line?.http?.request_id).toBe(res.headers["x-request-id"]);
    expect(line?.http?.route).toBe("/fail");
  });

  it("answers an error that carries a 4xx status with that status, not a 500", async () => {
    const clientError = Object.assign(new Error("bad input"), {
      status: HTTP_UNPROCESSABLE,
      expose: true,
    });
    const res = await request(failingApp(clientError)).get("/fail");
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(res.body).toEqual({ error: "Unprocessable Entity", code: "VALIDATION" });
    expect(out.lines().find((l) => l.msg === "request failed")?.level).toBe("warn");
  });
});

describe("the real app", () => {
  it("answers a malformed JSON body with 400, logs it and counts it as a 4xx", async () => {
    const res = await request(app)
      .post("/no-such-route")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(res.body).toEqual({ error: "Bad Request", code: "VALIDATION" });
    expect(res.headers["x-request-id"]).toBeDefined();

    const requestLine = out.lines().find((l) => l.msg === "request");
    expect(requestLine?.http?.status_code).toBe(HTTP_BAD_REQUEST);
    expect(requestLine?.http?.request_id).toBe(res.headers["x-request-id"]);

    const errors = (await registry.getMetricsAsJSON()).find((m) => m.name === "http_errors_total");
    expect(errors?.values ?? []).toHaveLength(0);
  });

  it("answers a body over the 1 MB limit with 413", async () => {
    const res = await request(app)
      .post("/no-such-route")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ filler: "x".repeat(OVER_THE_LIMIT_BYTES) }));
    expect(res.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(res.body).toEqual({ error: "Payload Too Large", code: "TOO_LARGE" });
  });

  it("does not log any part of a rejected request body", async () => {
    const marker = "BODY-MARKER-9f3a";
    await request(app).post("/no-such-route").set("Content-Type", "application/json").send(marker);
    await request(app)
      .post("/no-such-route")
      .set("Content-Type", "application/json")
      .send(`[1,2,${marker}]`);
    expect(out.raw()).not.toContain(marker);
    const failed = out.lines().filter((l) => l.msg === "request failed");
    expect(failed).toHaveLength(REJECTED_BODIES);
    failed.forEach((line) => {
      expect(line.error?.kind).toBe("SyntaxError");
      expect(line.error?.message).toBeUndefined();
      expect(line.error?.stack).toBeUndefined();
    });
  });
});

describe("errorHandler edge cases", () => {
  it("answers with the code docs/API.md lists for each status", async () => {
    const cases: [number, string][] = [
      [HTTP_BAD_REQUEST, "VALIDATION"],
      [HTTP_UNAUTHORIZED, "UNAUTHORIZED"],
      [HTTP_FORBIDDEN, "FORBIDDEN"],
      [HTTP_NOT_FOUND, "NOT_FOUND"],
      [HTTP_CONFLICT, "CONFLICT"],
      [HTTP_PAYLOAD_TOO_LARGE, "TOO_LARGE"],
      [HTTP_TOO_MANY_REQUESTS, "RATE_LIMITED"],
      [HTTP_IM_A_TEAPOT, "IM_A_TEAPOT"],
    ];
    for (const [status, code] of cases) {
      const err = Object.assign(new Error("x"), { status, expose: true });
      const res = await request(failingApp(err)).get("/fail");
      expect([res.status, res.body.code]).toEqual([status, code]);
    }
  });

  it("keeps a 500 for an error whose status is a server error", async () => {
    const serverError = Object.assign(new Error("upstream down"), { status: HTTP_UNAVAILABLE });
    const res = await request(failingApp(serverError)).get("/fail");
    expect(res.status).toBe(HTTP_INTERNAL_ERROR);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL" });
    expect(out.lines().find((l) => l.msg === "request failed")?.level).toBe("error");
  });

  it("logs a failure after the response has started and closes the connection itself", () => {
    const err = new Error("late");
    const passed: unknown[] = [];
    let destroyed = false;
    const res = {
      headersSent: true,
      getHeader: () => "rid-1",
      destroy: () => {
        destroyed = true;
      },
    } as unknown as Response;
    errorHandler(err, { method: "GET" } as Request, res, (e?: unknown) => passed.push(e));
    expect(passed).toEqual([]);
    expect(destroyed).toBe(true);
    const line = out.lines().find((l) => l.msg === "request failed");
    expect(line?.level).toBe("error");
    expect(line?.http?.request_id).toBe("rid-1");
  });
});
