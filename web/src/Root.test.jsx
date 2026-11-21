// Tests for the root: sign-in gate, a stored token checked with /auth/me, and sign out.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Root from "./Root.jsx";
import { loadToken, saveToken } from "./session.js";

const ANN = { id: "u1", email: "a@b.co", displayName: "Ann" };

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Answers by path; /health is the skeleton's health line in the footer
function routeFetch(routes) {
  const fetchMock = vi.fn(async (url) => {
    const answer = routes[url];
    if (!answer) throw new Error(`unexpected fetch ${url}`);
    return answer();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const health = () => json(200, { status: "ok" });

describe("Root", () => {
  it("shows the sign-in page when no token is stored", async () => {
    routeFetch({ "/health": health });

    render(<Root />);

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(await screen.findByLabelText("Service status: operational")).toBeTruthy();
    expect(screen.queryByText("API up")).toBeNull();
  });

  it("shows a footer with the team name", () => {
    routeFetch({ "/health": health });

    render(<Root />);

    expect(screen.getByRole("contentinfo").textContent).toContain("ContentCollab, ECE1779 Team 22");
  });

  it("marks the status dot as checking until /health answers", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<Root />);

    expect(screen.getByLabelText("Checking service status")).toBeTruthy();
  });

  it("marks the status dot unavailable when /health reports a problem", async () => {
    routeFetch({ "/health": () => json(503, { status: "degraded" }) });

    render(<Root />);

    expect(await screen.findByLabelText("Service status: unavailable")).toBeTruthy();
  });

  it("marks the status dot unavailable when /health cannot be reached", async () => {
    routeFetch({
      "/health": () => {
        throw new TypeError("Failed to fetch");
      },
    });

    render(<Root />);

    expect(await screen.findByLabelText("Service status: unavailable")).toBeTruthy();
  });

  it("after sign-in shows the user, the pages, and keeps the token", async () => {
    routeFetch({
      "/health": health,
      "/api/v1/auth/login": () => json(200, { token: "t0k", user: ANN }),
    });
    render(<Root />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pass1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Signed in as Ann")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Documents" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Document" })).toBeNull();
    expect(loadToken()).toBe("t0k");
  });

  it("checks a stored token with /auth/me and signs the user straight in", async () => {
    saveToken("t0k");
    const fetchMock = routeFetch({ "/health": health, "/api/v1/auth/me": () => json(200, ANN) });

    render(<Root />);

    expect(await screen.findByText("Signed in as Ann")).toBeTruthy();
    const meCall = fetchMock.mock.calls.find(([url]) => url === "/api/v1/auth/me");
    expect(meCall[1].headers.Authorization).toBe("Bearer t0k");
  });

  it("drops a stored token the API refuses and shows sign-in", async () => {
    saveToken("expired");
    routeFetch({
      "/health": health,
      "/api/v1/auth/me": () => json(401, { error: "Unauthorized", code: "UNAUTHORIZED" }),
    });

    render(<Root />);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(loadToken()).toBeNull();
  });

  it("keeps a stored token when /auth/me cannot be reached, and asks to sign in", async () => {
    saveToken("t0k");
    routeFetch({
      "/health": health,
      "/api/v1/auth/me": () => {
        throw new TypeError("Failed to fetch");
      },
    });

    render(<Root />);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(loadToken()).toBe("t0k");
  });

  it("signs out: forgets the token and returns to sign-in", async () => {
    saveToken("t0k");
    routeFetch({ "/health": health, "/api/v1/auth/me": () => json(200, ANN) });
    render(<Root />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(loadToken()).toBeNull();
  });

  it("opens the version in the address after sign-in, and follows the address when it changes", async () => {
    const DOC = "11111111-1111-4111-8111-111111111111";
    const VER = "22222222-2222-4222-8222-222222222222";
    saveToken("t0k");
    window.location.hash = `#/documents/${DOC}/versions/${VER}`;
    routeFetch({
      "/health": health,
      "/api/v1/auth/me": () => json(200, ANN),
      [`/api/v1/documents/${DOC}/versions/${VER}/comments?limit=100`]: () =>
        json(200, { items: [], nextCursor: null }),
    });

    render(<Root />);

    expect(await screen.findByRole("heading", { name: "Document" })).toBeTruthy();
    expect(await screen.findByText("No comments yet.")).toBeTruthy();

    act(() => {
      window.location.hash = "";
    });

    expect(await screen.findByRole("heading", { name: "Documents" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Document" })).toBeNull();
  });

  it("keeps the token in memory when storage is blocked, so comments still send it", async () => {
    const DOC = "11111111-1111-4111-8111-111111111111";
    const VER = "22222222-2222-4222-8222-222222222222";
    window.location.hash = `#/documents/${DOC}/versions/${VER}`;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => null);
    const fetchMock = routeFetch({
      "/health": health,
      "/api/v1/auth/login": () => json(200, { token: "mem0ry", user: ANN }),
      [`/api/v1/documents/${DOC}/versions/${VER}/comments?limit=100`]: () =>
        json(200, { items: [], nextCursor: null }),
    });
    render(<Root />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pass1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("No comments yet.");

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/comments?limit=100"));
    expect(call[1].headers.Authorization).toBe("Bearer mem0ry");
    vi.restoreAllMocks();
  });
});
