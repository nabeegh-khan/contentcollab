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
