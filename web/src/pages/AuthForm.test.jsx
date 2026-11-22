// The sign-in and register forms are real forms with the attributes Chrome's password manager needs to save and fill.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AuthPage from "./AuthPage.jsx";

describe("sign-in form", () => {
  it("is a real form whose email and password inputs carry the attributes a password manager reads", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { container } = render(<AuthPage onSignedIn={() => {}} />);

    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    expect(form.contains(email) && form.contains(password)).toBe(true);

    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("username");
    expect(email.getAttribute("name")).toBe("email");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(password.getAttribute("name")).toBe("password");
  });

  it("submits through the form's own submit button (not a click handler on a plain button)", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 400 })));
    const { container } = render(<AuthPage onSignedIn={() => {}} />);

    const button = screen.getByRole("button", { name: "Sign in" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(container.querySelector("form").contains(button)).toBe(true);
  });
});

describe("register form", () => {
  it("asks the password manager to save a new password, and keeps the email as the username", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { container } = render(<AuthPage onSignedIn={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Need an account? Register" }));

    const form = container.querySelector("form");
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    const name = screen.getByLabelText("Display name");
    expect(form.contains(email) && form.contains(password) && form.contains(name)).toBe(true);

    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("username");
    expect(email.getAttribute("name")).toBe("email");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    expect(password.getAttribute("name")).toBe("password");
    expect(name.getAttribute("autocomplete")).toBe("name");
    expect(name.getAttribute("name")).toBe("displayName");
    expect(screen.getByRole("button", { name: "Create account" }).getAttribute("type")).toBe(
      "submit",
    );
  });
});
