import type { Request } from "express";
import { HTTP_CLASS_SIZE } from "./httpStatus.js";

// The label used for a route in logs and metrics: the matched pattern
// ("/documents/:documentId"), never the raw URL, so the set of values stays as
// small as the set of routes. A request no route matched is "unmatched".
export const UNMATCHED = "unmatched";

export function routeLabel(req: Request): string {
  const pattern = req.route?.path;
  const full = typeof pattern === "string" ? `${req.baseUrl}${pattern}` : req.baseUrl;
  // A router mounted on "/health" with a "/" route reads "/health", not "/health/"
  const trimmed = full.length > 1 ? full.replace(TRAILING_SLASH, "") : full;
  return trimmed === "" ? UNMATCHED : trimmed;
}

// Matches one trailing slash: "/health/" becomes "/health"; "/health" is unchanged.
// Try it: https://regex101.com/?regex=%2F%24
const TRAILING_SLASH = /\/$/;

// "2xx", "4xx", "5xx": at most nine values whatever status a handler sets
export function statusClass(status: number): string {
  return `${Math.floor(status / HTTP_CLASS_SIZE)}xx`;
}
