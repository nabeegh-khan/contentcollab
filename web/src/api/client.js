// One request() helper for every API call: /api/v1, JSON, Bearer token, errors thrown with their real status.
export const API_BASE = "/api/v1";

// A non-2xx answer. code and details come from the API's { error, code, details } body (docs/API.md);
// an answer that is not that JSON (a proxy's HTML error page) keeps its status with code null.
export class ApiError extends Error {
  constructor(status, body) {
    const apiBody = body && typeof body === "object" ? body : {};
    super(apiBody.error || `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = apiBody.code ?? null;
    this.details = Array.isArray(apiBody.details) ? apiBody.details : [];
  }
}

function buildHeaders(body, token) {
  const headers = { Accept: "application/json" };
  if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function encodeBody(body) {
  if (body === undefined || body instanceof FormData) return body;
  return JSON.stringify(body);
}

async function readBody(response) {
  if (response.status === 204) return null;
  const type = response.headers.get("Content-Type") || "";
  if (!type.includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function request(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: buildHeaders(body, token),
    body: encodeBody(body),
  });
  const parsed = await readBody(response);
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed;
}
