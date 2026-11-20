// Tests for the root: sign-in gate, a stored token checked with /auth/me, and sign out.
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(await screen.findByText("API up")).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "Document" })).toBeTruthy();
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
});
