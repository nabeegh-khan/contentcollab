// Tests for request(): the URL, headers and body it sends, and the errors it throws (docs/API.md).
import { describe, expect, it, vi } from "vitest";
import { ApiError, request } from "./client.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function mockFetch(response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function caught(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to throw");
}

describe("request", () => {
  it("sends JSON under /api/v1 with the bearer token and returns the parsed body", async () => {
    const fetchMock = mockFetch(jsonResponse(201, { id: "u1", email: "a@b.co" }));

    const body = await request("/auth/register", {
      method: "POST",
      body: { email: "a@b.co" },
      token: "t0k",
    });

    expect(body).toEqual({ id: "u1", email: "a@b.co" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/register");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"email":"a@b.co"}');
    expect(init.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer t0k",
    });
  });

  it("sends no Authorization header and no body when there is no token or body", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }));

    await request("/auth/me");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Accept: "application/json" });
  });

  it("sends FormData as it is, without a Content-Type, so the browser sets the boundary", async () => {
    const fetchMock = mockFetch(jsonResponse(201, { id: "d1" }));
    const form = new FormData();
    form.append("title", "Plan");

    await request("/documents", { method: "POST", body: form, token: "t0k" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(form);
    expect(init.headers).toEqual({ Accept: "application/json", Authorization: "Bearer t0k" });
  });

  it("returns null for 204 No Content", async () => {
    mockFetch(new Response(null, { status: 204 }));

    await expect(request("/documents/d1", { method: "DELETE" })).resolves.toBeNull();
  });

  it("throws 401 with the API's code and message", async () => {
    mockFetch(jsonResponse(401, { error: "Invalid Email or Password", code: "UNAUTHORIZED" }));

    const error = await caught(request("/auth/login", { method: "POST", body: {} }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.message).toBe("Invalid Email or Password");
    expect(error.details).toEqual([]);
  });

  it("throws 409 CONFLICT for a taken email", async () => {
    mockFetch(jsonResponse(409, { error: "Email Already Registered", code: "CONFLICT" }));

    const error = await caught(request("/auth/register", { method: "POST", body: {} }));

    expect(error.status).toBe(409);
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe("Email Already Registered");
  });

  it("throws 400 VALIDATION with the field details", async () => {
    const details = [{ field: "password", message: "Too small: expected string to have >=8 characters" }];
    mockFetch(jsonResponse(400, { error: "Validation Failed", code: "VALIDATION", details }));

    const error = await caught(request("/auth/register", { method: "POST", body: {} }));

    expect(error.status).toBe(400);
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toEqual(details);
  });

  it("throws 413 TOO_LARGE from the API's JSON body", async () => {
    mockFetch(jsonResponse(413, { error: "Payload Too Large", code: "TOO_LARGE" }));

    const error = await caught(request("/documents", { method: "POST", body: new FormData() }));

    expect(error.status).toBe(413);
    expect(error.code).toBe("TOO_LARGE");
  });

  it("keeps the real status when the body is not the API's JSON (a proxy's HTML 413 page)", async () => {
    mockFetch(
      new Response("<html><body>413 Request Entity Too Large</body></html>", {
        status: 413,
        statusText: "Request Entity Too Large",
        headers: { "Content-Type": "text/html" },
      }),
    );

    const error = await caught(request("/documents", { method: "POST", body: new FormData() }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(413);
    expect(error.code).toBeNull();
    expect(error.message).toBe("Request failed with status 413");
  });

  it("lets a network failure reach the caller unchanged", async () => {
    const failure = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));

    await expect(request("/auth/me")).rejects.toBe(failure);
  });
});
