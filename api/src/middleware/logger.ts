import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { HTTP_CLIENT_ERROR_MIN, HTTP_SERVER_ERROR_MIN } from "../lib/httpStatus.js";
import { log, type Level } from "../lib/log.js";
import { routeLabel } from "../lib/routeLabel.js";

// Routes the platform calls every few seconds; a successful answer is logged
// at debug, so the readiness probe does not fill the log at the default level.
const PROBE_ROUTES = new Set(["/health", "/metrics"]);

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const DURATION_DECIMALS = 2;

// An incoming request ID is accepted only in this shape, so a client cannot
// put a long or odd value into the log or the response header.
// Accepts 1 to 128 letters, digits, dots, underscores and hyphens:
// matches "web-7f3a.1_ok"; rejects "bad id with spaces" and 'a"b'.
// Try it: https://regex101.com/?regex=%5E%5BA-Za-z0-9._-%5D%7B1%2C128%7D%24
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestIdFrom(header: string | string[] | undefined): string {
  return typeof header === "string" && SAFE_REQUEST_ID.test(header) ? header : randomUUID();
}

function levelFor(status: number, route: string): Level {
  if (status >= HTTP_SERVER_ERROR_MIN) return "error";
  if (status >= HTTP_CLIENT_ERROR_MIN) return "warn";
  return PROBE_ROUTES.has(route) ? "debug" : "info";
}

// Gives the request an ID, returned in X-Request-Id (the error handler reads
// it from there), and writes one JSON line when the response has finished, so
// the status and the duration are final.
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const id = requestIdFrom(req.headers["x-request-id"]);
  res.setHeader("X-Request-Id", id);
  const started = process.hrtime.bigint();

  res.on("finish", () => {
    const route = routeLabel(req);
    const elapsedNs = Number(process.hrtime.bigint() - started);
    const durationMs = elapsedNs / NANOSECONDS_PER_MILLISECOND;
    log(levelFor(res.statusCode, route), "request", {
      http: { request_id: id, method: req.method, route, status_code: res.statusCode },
      duration_ms: Number(durationMs.toFixed(DURATION_DECIMALS)),
    });
  });
  next();
}
