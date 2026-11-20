// Vitest for the browser client: jsdom stands in for the browser, fetch is mocked per test (D26).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{js,jsx}"],
    setupFiles: ["./src/test-setup.js"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
