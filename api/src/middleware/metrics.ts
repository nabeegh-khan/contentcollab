import type { NextFunction, Request, Response } from "express";
import { httpDuration, httpErrors, httpRequests } from "../lib/metrics.js";

// Records every response once it has finished, so the status and the
// duration are final. The route label is the matched pattern
// ("/documents/:id"), never the raw URL, so the label set stays small.
export function requestMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl || "unmatched";
    const labels = { method: req.method, route };
    end(labels);
    httpRequests.inc({ ...labels, status: String(res.statusCode) });
    if (res.statusCode >= 500) {
      httpErrors.inc({ route });
    }
  });
  next();
}
