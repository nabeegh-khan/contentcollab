import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// One registry for the process. /metrics renders it in the Prometheus text
// format; Datadog and Prometheus both scrape that (OBS-4).
export const registry = new Registry();

// CPU, memory, event-loop lag and the like, free from the library
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: "http_requests_total",
  help: "Requests served, by method, route and status code",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

// Buckets from 5 ms to 5 s: the p95 alert in the proposal is one second. Shared with the
// status page's quantiles (#30), which are read as bucket upper bounds
export const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Request latency in seconds, by method and route",
  labelNames: ["method", "route"] as const,
  buckets: LATENCY_BUCKETS_SECONDS,
  registers: [registry],
});

export const httpErrors = new Counter({
  name: "http_errors_total",
  help: "Responses with a 5xx status, by route",
  labelNames: ["route"] as const,
  registers: [registry],
});
