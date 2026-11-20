// Render and behaviour tests for the sign-in and register page against the auth routes on main.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AuthPage from "./AuthPage.jsx";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fill(label, value) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("AuthPage", () => {
  it("renders the sign-in form without a display name field", () => {
    render(<AuthPage onSignedIn={() => {}} />);

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.queryByLabelText("Display name")).toBeNull();
  });

  it("signs in and hands the token and user up", async () => {
    const user = { id: "u1", email: "a@b.co", displayName: "Ann" };
    const fetchMock = vi.fn().mockResolvedValue(json(200, { token: "t0k", user }));
    vi.stubGlobal("fetch", fetchMock);
    const onSignedIn = vi.fn();
    render(<AuthPage onSignedIn={onSignedIn} />);

    fill("Email", "a@b.co");
    fill("Password", "pass1234");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ token: "t0k", user }));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/v1/auth/login"]);
  });

  it("registers, then signs in with the same email and password", async () => {
    const user = { id: "u1", email: "a@b.co", displayName: "Ann" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(201, user))
      .mockResolvedValueOnce(json(200, { token: "t0k", user }));
    vi.stubGlobal("fetch", fetchMock);
    const onSignedIn = vi.fn();
    render(<AuthPage onSignedIn={onSignedIn} />);

    fireEvent.click(screen.getByRole("button", { name: "Need an account? Register" }));
    fill("Email", "a@b.co");
    fill("Password", "pass1234");
    fill("Display name", "Ann");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ token: "t0k", user }));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/auth/register",
      "/api/v1/auth/login",
    ]);
  });

  it("shows the API's message for a taken email and stays on the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(409, { error: "Email Already Registered", code: "CONFLICT" })),
    );
    const onSignedIn = vi.fn();
    render(<AuthPage onSignedIn={onSignedIn} />);

    fireEvent.click(screen.getByRole("button", { name: "Need an account? Register" }));
    fill("Email", "a@b.co");
    fill("Password", "pass1234");
    fill("Display name", "Ann");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Email Already Registered");
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("lists each field the API rejected", async () => {
    const details = [{ field: "password", message: "at least 8 characters" }];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(json(400, { error: "Validation Failed", code: "VALIDATION", details })),
    );
    render(<AuthPage onSignedIn={() => {}} />);

    fill("Email", "a@b.co");
    fill("Password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Validation Failed");
    expect(alert.textContent).toContain("password: at least 8 characters");
  });

  it("says the server could not be reached when fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<AuthPage onSignedIn={() => {}} />);

    fill("Email", "a@b.co");
    fill("Password", "pass1234");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Could not reach the server.");
  });
});
