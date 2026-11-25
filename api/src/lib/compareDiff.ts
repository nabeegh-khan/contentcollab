// The diff function the compare route uses (D39): the DigitalOcean Function when FUNCTION_DIFF_URL and
// FUNCTION_AUTH_TOKEN are set, the local diff otherwise and on any failure. Kept apart from the route so its
// wiring can be tested without a database.
import { lineDiff } from "./diff.js";
import { diffWith, functionConfigFromEnv, type InvocationStore } from "./functionDiff.js";

export function compareDiff(
  env: Record<string, string | undefined>,
  store: InvocationStore,
  fetchFn: typeof fetch = fetch,
) {
  return diffWith({ config: functionConfigFromEnv(env), fetchFn, local: lineDiff, store });
}
