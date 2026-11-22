// Tests for the token kept in sessionStorage, including a browser that refuses storage.
import { describe, expect, it, vi } from "vitest";
import { clearToken, loadToken, saveToken } from "./session.js";

describe("session token", () => {
  it("saves, loads and clears the token", () => {
    expect(loadToken()).toBeNull();
    saveToken("t0k");
    expect(loadToken()).toBe("t0k");
    clearToken();
    expect(loadToken()).toBeNull();
  });

  it("keeps the token per tab: it goes to sessionStorage and never to localStorage, so two tabs of one Chrome can hold two users", () => {
    localStorage.clear();
    saveToken("tab-one-token");
    expect(sessionStorage.getItem("contentcollab.token")).toBe("tab-one-token");
    expect(localStorage.length).toBe(0);

    // another tab has its own sessionStorage: empty, and a stale localStorage token is never read
    sessionStorage.clear();
    localStorage.setItem("contentcollab.token", "another-tab-left-this");
    expect(loadToken()).toBeNull();
    localStorage.clear();
  });

  it("does not throw when storage is blocked; nothing is remembered", () => {
    const blocked = () => {
      throw new Error("SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);

    expect(() => saveToken("t0k")).not.toThrow();
    expect(loadToken()).toBeNull();
    expect(() => clearToken()).not.toThrow();
  });
});
