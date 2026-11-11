import type { Request } from "express";
import { HTTP_CLASS_SIZE } from "./httpStatus.js";

// The label used for a route in logs and metrics: the pattern the request
// matched ("/documents/:documentId"), never the raw URL, so the set of values
// stays as small as the set of routes. A request no route matched is
// "unmatched".
export const UNMATCHED = "unmatched";

// Matches one trailing slash: "/health/" becomes "/health"; "/health" is unchanged.
// Try it: https://regex101.com/?regex=%2F%24
const TRAILING_SLASH = /\/$/;

// The mount path comes from the request, so its case is the client's: a
// router mounted on "/health" also answers "/HEALTH". Lower case keeps one
// label. Mount routers on literal paths and put parameters in the route
// (`router.get("/:documentId")`), because a parameter in a mount path would
// put its value into the label.
function build(baseUrl: string, pattern: unknown): string {
  // A route registered with a regular expression or an array has no string
  // path; its text is fixed in the code, so it is still a bounded label
  const route = typeof pattern === "string" ? pattern : String(pattern);
  const full = `${baseUrl.toLowerCase()}${route}`;
  const trimmed = full.length > 1 ? full.replace(TRAILING_SLASH, "") : full;
  return trimmed === "" ? UNMATCHED : trimmed;
}

const labels = new WeakMap<Request, string>();

// Express restores `req.baseUrl` once a router finishes, so after an error or
// a fall-through the mount path is gone while `req.route` is still set. The
// label is therefore taken at the moment Express assigns `req.route` (the
// request is then inside the router that matched, with `baseUrl` correct) and
// reset when it is cleared. Call once per request, before routing; calling it
// again does nothing. Limit: Express never clears `req.route` when a route
// calls `next()`, so a request that a route passes on to the catch-all 404 keeps
// that route's label; handlers here answer their own 404 and do not do this.
export function trackRoute(req: Request): void {
  if (labels.has(req)) return;
  labels.set(req, UNMATCHED);
  let current: unknown;
  Object.defineProperty(req, "route", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (route: { path?: unknown } | undefined) => {
      current = route;
      labels.set(req, route?.path === undefined ? UNMATCHED : build(req.baseUrl, route.path));
    },
  });
}

export function routeLabel(req: Request): string {
  const tracked = labels.get(req);
  if (tracked !== undefined) return tracked;
  // Not tracked (a request that bypassed the middleware): the best the request itself can say
  return req.route?.path === undefined ? UNMATCHED : build(req.baseUrl, req.route.path);
}

// "2xx", "4xx", "5xx": at most nine values whatever status a handler sets
export function statusClass(status: number): string {
  return `${Math.floor(status / HTTP_CLASS_SIZE)}xx`;
}
