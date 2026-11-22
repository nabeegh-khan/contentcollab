// The operations route (docs/API.md, GET /ops; D31), on the shared request() helper.
import { request } from "../api/client.js";

const GIVE_UP_MS = 4000;

// Resolves to the snapshot; the API answers 401 (no token), 403 (not an operator). A request that
// has not answered in 4 s is dropped, so one stalled connection never ends the refreshing. An answer
// that is not the snapshot (a proxy serving an HTML page with status 200) is a failure, not data.
export async function getOps(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GIVE_UP_MS);
  try {
    const snapshot = await request("/ops", { token, signal: controller.signal });
    if (!snapshot || typeof snapshot !== "object" || typeof snapshot.generatedAt !== "string") {
      throw new Error("the operations route did not answer with a snapshot");
    }
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

// The restart drill (D31): resolves to { target, pod, startedAt, nextAllowedAt }. The API answers 429
// (one a minute), 409 (not enough ready pods), 403 (not an operator, or drills switched off), 502, 503.
export function startDrill(token, target) {
  return request("/ops/drills", { method: "POST", body: { target }, token });
}

// Per-pod CPU and memory for the charts: resolves to { series } or { series: null, error }
export function getSeries(token) {
  return request("/ops/series", { token });
}
