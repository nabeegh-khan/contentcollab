import { STATUS_CODES } from "node:http";
import type { NextFunction, Request, Response } from "express";
import {
  HTTP_CLIENT_ERROR_MIN,
  HTTP_INTERNAL_ERROR,
  HTTP_SERVER_ERROR_MIN,
} from "../lib/httpStatus.js";
import { errorFields, log } from "../lib/log.js";
import { routeLabel } from "../lib/routeLabel.js";

// An error that carries a 4xx status (a malformed body or one over the size
// limit raises one) is the client's mistake, not a server fault: it answers
// with that status and does not count toward the 5xx error rate.
function clientErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  const isClientError =
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= HTTP_CLIENT_ERROR_MIN &&
    status < HTTP_SERVER_ERROR_MIN;
  return isClientError ? status : undefined;
}

// Last middleware in the chain. The client gets a fixed shape and no detail;
// the detail goes to the log as one JSON line with the request's ID. Express
// only treats a 4-argument function as an error handler.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const clientStatus = clientErrorStatus(err);
  log(clientStatus ? "warn" : "error", "request failed", {
    http: {
      request_id: res.getHeader("X-Request-Id"),
      method: req.method,
      route: routeLabel(req),
    },
    error: errorFields(err),
  });
  const status = clientStatus ?? HTTP_INTERNAL_ERROR;
  res.status(status).json({ error: STATUS_CODES[status] });
}
