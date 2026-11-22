// Unmounts what each test rendered, empties sessionStorage and the address hash, so tests do not see each other.
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.location.hash = "";
});
