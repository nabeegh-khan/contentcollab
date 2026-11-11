import type { NextFunction, Request, Response } from "express";
import { HTTP_INTERNAL_ERROR, HTTP_SERVER_ERROR_MIN } from "../lib/httpStatus.js";
import { httpDuration, httpErrors, httpRequests } from "../lib/metrics.js";
import { failedMidResponse } from "../lib/midResponse.js";
import { routeLabel, statusClass, trackRoute } from "../lib/routeLabel.js";

// Records every response once it has finished, so the status and the
// duration are final. The route label is the matched pattern
// ("/documents/:id"), never the raw URL, and the status is its class
// ("2xx"), so the label set stays small however many paths clients send.
// A response the server broke after its headers went out counts as a 5xx when
// the connection closes. A request the client gave up on has no status and is
// not counted: the "request aborted" log line is where it shows (D16).
export function requestMetrics(req: Request, res: Response, next: NextFunction): void {
  trackRoute(req);
  const end = httpDuration.startTimer();
  const record = (status: number) => {
    const route = routeLabel(req);
    end({ method: req.method, route });
    const labels = { method: req.method, route, status_class: statusClass(status) };
    httpRequests.inc(labels);
    if (status >= HTTP_SERVER_ERROR_MIN) {
      httpErrors.inc(labels);
    }
  };
  res.on("finish", () => record(res.statusCode));
  res.on("close", () => {
    if (!res.writableFinished && failedMidResponse(res)) record(HTTP_INTERNAL_ERROR);
  });
  next();
}
