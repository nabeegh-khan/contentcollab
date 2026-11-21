// Unmounts what each test rendered and empties sessionStorage, so tests do not see each other.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
