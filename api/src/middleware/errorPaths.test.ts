import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import {
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_PAYLOAD_TOO_LARGE,
} from "../lib/httpStatus.js";
import { captureStdout } from "../lib/logCapture.js";
import { registry } from "../lib/metrics.js";
import app from "../server.js";
import { errorHandler } from "./errorHandler.js";
import { requestLogger } from "./logger.js";
import { requestMetrics } from "./metrics.js";

// Error paths found in the second review of #55: a failure after the response
// has started, odd thrown values, errors that carry a status, the body parser
// in the real app, and the log level setting.

const OVER_THE_LIMIT_BYTES = 1_100_000;
const LONGEST_REQUEST_ID = 128;
// The LOG_LEVEL test sends two requests and expects one warning
const REQUESTS_SENT = 2;

let out: ReturnType<typeof captureStdout>;
beforeEach(() => {
  delete process.env.LOG_LEVEL;
  out = captureStdout();
  registry.resetMetrics();
});
afterEach(() => {
  out.restore();
  delete process.env.LOG_LEVEL;
});

type Sample = { value: number; labels: Record<string, string | number> };
async function samples(name: string): Promise<Sample[]> {
  const all = await registry.getMetricsAsJSON();
  return (all.find((m) => m.name === name)?.values ?? []) as Sample[];
}

function appWith(route: (req: Request, res: Response, next: NextFunction) => void) {
  const a = express();
  a.use(requestLogger);
  a.use(requestMetrics);
  a.get("/", (req, res) => res.json({ root: true }));
  a.get("/x", route);
  a.use((req, res) => res.status(HTTP_NOT_FOUND).json({ error: "Not Found" }));
  a.use(errorHandler);
  return a;
}

// Sends one GET and resolves once the connection has closed, whatever happened to it
async function getRaw(a: express.Express, path: string): Promise<void> {
  const server = a.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = httpRequest({ port, path, host: "127.0.0.1" }, (res) => {
        res.resume();
        res.on("close", () => resolve());
        res.on("error", () => resolve());
      });
      req.on("error", () => resolve());
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("a server error after the response has started", () => {
  it("is logged and counted as a server error, not as the client going away", async () => {
    await getRaw(
      appWith((req, res, next) => {
        res.status(HTTP_OK).write("partial");
        next(new Error("db died mid-stream"));
      }),
      "/x",
    );
    // The close event of the server side can follow the client's by a tick
    await new Promise((resolve) => setImmediate(resolve));
    // lines() also fails on any console call, so nothing went to stderr as plain text
    const lines = out.lines();
    const failed = lines.find((l) => l.msg === "request failed");
    expect(failed?.level).toBe("error");
    expect(failed?.error?.message).toBe("db died mid-stream");
    const done = lines.find((l) => l.msg === "request");
    expect(done?.level).toBe("error");
    expect(done?.http?.status_code).toBe(HTTP_INTERNAL_ERROR);
    expect(done?.http?.request_id).toBe(failed?.http?.request_id);
    expect(lines.some((l) => l.msg === "request aborted")).toBe(false);
    expect(await samples("http_errors_total")).toEqual([
      expect.objectContaining({
        labels: { method: "GET", route: "/x", status_class: "5xx" },
        value: 1,
      }),
    ]);
  });
});

describe("odd thrown values", () => {
  it("a thrown string is a NonError with its text as the message", async () => {
    const res = await request(
      appWith(() => {
        throw "plain string";
      }),
    ).get("/x");
    expect(res.status).toBe(HTTP_INTERNAL_ERROR);
    const failed = out.lines().find((l) => l.msg === "request failed");
    expect(failed?.error).toEqual({ kind: "NonError", message: "plain string" });
  });

  it("a value that cannot be turned into text still gets the JSON 500 and one log line", async () => {
    const res = await request(appWith((req, res, next) => next(Object.create(null)))).get("/x");
    expect(res.status).toBe(HTTP_INTERNAL_ERROR);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL" });
    const failed = out.lines().find((l) => l.msg === "request failed");
    expect(failed?.error).toEqual({ kind: "NonError", message: "(unprintable value)" });
  });
});

describe("an error that carries a status", () => {
  it("is the client's only when it says its message may be shown (expose), as body-parser's errors do", async () => {
    const upstream = Object.assign(new Error("upstream said 404"), { status: HTTP_NOT_FOUND });
    const hidden = await request(
      appWith(() => {
        throw upstream;
      }),
    ).get("/x");
    expect(hidden.status).toBe(HTTP_INTERNAL_ERROR);
    expect(out.lines().find((l) => l.msg === "request failed")?.level).toBe("error");

    const client = Object.assign(new Error("not here"), { status: HTTP_NOT_FOUND, expose: true });
    const shown = await request(
      appWith(() => {
        throw client;
      }),
    ).get("/x");
    expect(shown.status).toBe(HTTP_NOT_FOUND);
  });
});

describe("the real app's body parser", () => {
  it("a malformed body is counted as one 4xx request, so the metrics run before the parser", async () => {
    await request(app).post("/no-such-route").set("Content-Type", "application/json").send("{bad");
    expect(await samples("http_requests_total")).toEqual([
      expect.objectContaining({
        labels: { method: "POST", route: "unmatched", status_class: "4xx" },
        value: 1,
      }),
    ]);
  });

  it("a body over the limit is logged at warn with its kind only, and is not a 5xx", async () => {
    const res = await request(app)
      .post("/no-such-route")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ filler: "x".repeat(OVER_THE_LIMIT_BYTES) }));
    expect(res.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    const failed = out.lines().find((l) => l.msg === "request failed");
    expect(failed?.level).toBe("warn");
    expect(failed?.error).toEqual({ kind: "PayloadTooLargeError" });
    expect(await samples("http_errors_total")).toEqual([]);
  });
});

describe("request lines", () => {
  it("a successful /metrics, like /health, is not logged at the default level", async () => {
    const a = express();
    a.use(requestLogger);
    a.get("/metrics", (req, res) => res.send("x 1"));
    await request(a).get("/metrics").expect(HTTP_OK);
    expect(out.lines().filter((l) => l.msg === "request")).toEqual([]);
  });

  it("accepts a request ID of exactly 128 characters", async () => {
    const id = "a".repeat(LONGEST_REQUEST_ID);
    const res = await request(appWith((req, res) => res.json({})))
      .get("/x")
      .set("X-Request-Id", id);
    expect(res.headers["x-request-id"]).toBe(id);
  });

  it("labels the root route '/', not unmatched", async () => {
    await request(appWith((req, res) => res.json({}))).get("/");
    expect(out.lines().find((l) => l.msg === "request")?.http?.route).toBe("/");
  });
});

describe("LOG_LEVEL", () => {
  it("is read in any case", async () => {
    process.env.LOG_LEVEL = "DEBUG";
    const a = express();
    a.use(requestLogger);
    a.get("/health", (req, res) => res.json({ status: "ok" }));
    await request(a).get("/health").expect(HTTP_OK);
    expect(out.lines().find((l) => l.msg === "request")?.level).toBe("debug");
  });

  it("an unknown value falls back to info and says so once", async () => {
    process.env.LOG_LEVEL = "loud-and-unknown";
    const a = appWith((req, res) => res.json({}));
    await request(a).get("/x");
    await request(a).get("/x");
    const warnings = out.lines().filter((l) => l.msg === "unknown LOG_LEVEL, using info");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe("warn");
    expect(warnings[0]?.log_level).toBe("loud-and-unknown");
    expect(out.lines().filter((l) => l.msg === "request")).toHaveLength(REQUESTS_SENT);
  });
});
