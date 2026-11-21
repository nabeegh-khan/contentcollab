// Unmounts what each test rendered, empties sessionStorage and the address hash, so tests do not see each other.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.location.hash = "";
});
