import type { NextFunction, Request, Response } from "express";
import { HTTP_SERVER_ERROR_MIN } from "../lib/httpStatus.js";
import { httpDuration, httpErrors, httpRequests } from "../lib/metrics.js";
import { routeLabel, statusClass } from "../lib/routeLabel.js";

// Records every response once it has finished, so the status and the
// duration are final. The route label is the matched pattern
// ("/documents/:id"), never the raw URL, and the status is its class
// ("2xx"), so the label set stays small however many paths clients send.
export function requestMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const route = routeLabel(req);
    end({ method: req.method, route });
    const labels = { method: req.method, route, status_class: statusClass(res.statusCode) };
    httpRequests.inc(labels);
    if (res.statusCode >= HTTP_SERVER_ERROR_MIN) {
      httpErrors.inc(labels);
    }
  });
  next();
}
