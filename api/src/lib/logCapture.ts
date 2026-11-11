import { jest } from "@jest/globals";

// Test helper: collects what the process writes to standard output, so a test
// can read the JSON log lines a request produced. Restore it in afterEach.
export type LogLine = {
  timestamp?: string;
  level?: string;
  msg?: string;
  http?: { request_id?: string; method?: string; route?: string; status_code?: number };
  duration_ms?: number;
  error?: { kind?: string; message?: string; stack?: string; code?: string };
  [key: string]: unknown;
};

// Jest replaces console, so console.log never reaches process.stdout.write:
// it is watched separately, or a plain-text line would slip past the capture
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

export function captureStdout() {
  const chunks: string[] = [];
  const spy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
    return true;
  }) as typeof process.stdout.write);
  const consoleCalls: string[] = [];
  const consoleSpies = CONSOLE_METHODS.map((method) =>
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(`console.${method}: ${args.map(String).join(" ")}`);
    }),
  );

  return {
    // Everything written to standard output, as one string
    raw: (): string => chunks.join(""),
    // Every non-empty line parsed as JSON. A line that is not JSON throws, and
    // so does any console call, so a stray plain-text log line fails the test
    // that reads the lines
    lines: (): LogLine[] => {
      if (consoleCalls.length > 0) {
        throw new Error(`plain-text output instead of a JSON line: ${consoleCalls.join("; ")}`);
      }
      return chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as LogLine);
    },
    restore: (): void => {
      spy.mockRestore();
      consoleSpies.forEach((s) => s.mockRestore());
    },
  };
}
