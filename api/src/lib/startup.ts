import { errorFields, log } from "./log.js";

// The lines server.ts writes outside a request, as JSON like every other line
// on standard output (OBS-1, ARCHITECTURE D16), so the API's whole output can
// be parsed.

export function logListening(port: number): void {
  log("info", "api listening", { port });
}

// With node-redis's default retry strategy this never happens; it is kept for
// a strategy that gives up, after which the pod stays unready until restarted
export function logRedisGaveUp(err: unknown): void {
  log(
    "error",
    "redis: client stopped retrying; /health reports Redis down until the API restarts",
    {
      component: "redis",
      error: errorFields(err),
    },
  );
}
