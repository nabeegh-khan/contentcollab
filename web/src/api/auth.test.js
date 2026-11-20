// Tests for the three auth calls on main (POST /auth/register, POST /auth/login, GET /auth/me).
import { describe, expect, it, vi } from "vitest";
import { login, me, register } from "./auth.js";

function okJson(status, body) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("auth calls", () => {
  it("register posts email, password and displayName", async () => {
    const fetchMock = okJson(201, { id: "u1" });

    await register({ email: "a@b.co", password: "pass1234", displayName: "Ann" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/register");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      email: "a@b.co",
      password: "pass1234",
      displayName: "Ann",
    });
  });

  it("login posts only email and password and returns { token, user }", async () => {
    const fetchMock = okJson(200, { token: "t0k", user: { id: "u1", displayName: "Ann" } });

    const result = await login({ email: "a@b.co", password: "pass1234" });

    expect(result).toEqual({ token: "t0k", user: { id: "u1", displayName: "Ann" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "a@b.co", password: "pass1234" });
  });

  it("me sends the token and returns the user", async () => {
    const fetchMock = okJson(200, { id: "u1", displayName: "Ann" });

    await expect(me("t0k")).resolves.toEqual({ id: "u1", displayName: "Ann" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/me");
    expect(init.headers.Authorization).toBe("Bearer t0k");
  });
});
