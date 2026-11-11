import { jest } from "@jest/globals";

// Test helper: collects what the process writes to standard output, so a test
// can read the JSON log lines a request produced. Restore it in afterEach.
export type LogLine = {
  timestamp?: string;
  level?: string;
  msg?: string;
  http?: { request_id?: string; method?: string; route?: string; status_code?: number };
  duration_ms?: number;
  error?: { kind?: string; message?: string; stack?: string };
  [key: string]: unknown;
};

export function captureStdout() {
  const chunks: string[] = [];
  const spy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
    return true;
  }) as typeof process.stdout.write);

  return {
    // Everything written, as one string
    raw: (): string => chunks.join(""),
    // Every non-empty line parsed as JSON; a line that is not JSON throws, so
    // a stray plain-text log line fails the test that reads it
    lines: (): LogLine[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as LogLine),
    restore: (): void => spy.mockRestore(),
  };
}
