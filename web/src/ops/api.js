// The operations route (docs/API.md, GET /ops; D31), on the shared request() helper.
import { request } from "../api/client.js";

// Resolves to the snapshot; the API answers 401 (no token), 403 (not an operator)
export function getOps(token) {
  return request("/ops", { token });
}
