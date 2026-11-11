import { STATUS_CODES } from "node:http";
import type { NextFunction, Request, Response } from "express";
import {
  HTTP_BAD_REQUEST,
  HTTP_CLIENT_ERROR_MIN,
  HTTP_CONFLICT,
  HTTP_FORBIDDEN,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_SERVER_ERROR_MIN,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
} from "../lib/httpStatus.js";
import { errorFields, log } from "../lib/log.js";
import { markFailedMidResponse } from "../lib/midResponse.js";
import { routeLabel } from "../lib/routeLabel.js";

// The codes of the error shape in docs/API.md. Another 4xx gets its status
// name in upper snake case ("IM_A_TEAPOT"); every 5xx is INTERNAL.
const CODES: Record<number, string> = {
  [HTTP_BAD_REQUEST]: "VALIDATION",
  [HTTP_UNPROCESSABLE]: "VALIDATION",
  [HTTP_UNAUTHORIZED]: "UNAUTHORIZED",
  [HTTP_FORBIDDEN]: "FORBIDDEN",
  [HTTP_NOT_FOUND]: "NOT_FOUND",
  [HTTP_CONFLICT]: "CONFLICT",
  [HTTP_PAYLOAD_TOO_LARGE]: "TOO_LARGE",
  [HTTP_TOO_MANY_REQUESTS]: "RATE_LIMITED",
};

// Apostrophes are dropped, so "I'm a Teapot" reads "Im a Teapot".
// Try it: https://regex101.com/?regex='
const APOSTROPHE = /'/g;
// Each run of characters that is not a letter or digit: the spaces in "Im a Teapot" (and "-" in "Pre-Condition").
// Try it: https://regex101.com/?regex=%5B%5EA-Za-z0-9%5D%2B
const NOT_ALPHANUMERIC = /[^A-Za-z0-9]+/g;

function codeFor(status: number): string {
  if (status >= HTTP_SERVER_ERROR_MIN) return "INTERNAL";
  const name = (STATUS_CODES[status] ?? "Error").replace(APOSTROPHE, "");
  return CODES[status] ?? name.replace(NOT_ALPHANUMERIC, "_").toUpperCase();
}

// An error is the client's mistake only when it carries a 4xx status and says
// its message may be shown (`expose`, which body-parser and http-errors set
// for a malformed body or one over the size limit). It answers with that
// status and does not count toward the 5xx error rate. A 4xx status without
// `expose` (an upstream client's 404, say) is our failure: a 500.
function clientErrorStatus(err: unknown): number | undefined {
  const { status, expose } = (err ?? {}) as { status?: unknown; expose?: unknown };
  const isClientError =
    expose === true &&
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= HTTP_CLIENT_ERROR_MIN &&
    status < HTTP_SERVER_ERROR_MIN;
  return isClientError ? status : undefined;
}

// Last middleware in the chain. The client gets the fixed shape of docs/API.md
// and no detail; the detail goes to the log as one JSON line with the
// request's ID. Express only treats a 4-argument function as an error handler.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const clientStatus = res.headersSent ? undefined : clientErrorStatus(err);
  log(clientStatus ? "warn" : "error", "request failed", {
    http: {
      request_id: res.getHeader("X-Request-Id"),
      method: req.method,
      route: routeLabel(req),
    },
    // A 4xx error comes from what the client sent, and its message can quote
    // the body (a JSON parse error does): log only its kind. A server error
    // is ours, so its message and stack are the evidence.
    error: clientStatus ? { kind: errorFields(err).kind } : errorFields(err),
  });
  if (res.headersSent) {
    // Too late for a status: the response is cut off, which is what Express's
    // default handler would do, without its plain-text stack on stderr. The
    // logger and the metrics count it as a 5xx when the connection closes.
    markFailedMidResponse(res);
    res.destroy();
    return;
  }
  const status = clientStatus ?? HTTP_INTERNAL_ERROR;
  res.status(status).json({ error: STATUS_CODES[status], code: codeFor(status) });
  // `next` is part of the error-handler signature Express looks for; nothing follows this handler
  void next;
}
