// Tests that an idle client's error on the shared pool is logged and does not crash the process (ARCHITECTURE D26, #68).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { captureStdout } from "./logCapture.js";
import { pool } from "./db.js";

// One error node-postgres passes when PostgreSQL goes away under an idle client
const lostConnection = (): Error => new Error("Connection terminated unexpectedly");

// What a graceful PostgreSQL shutdown sends first: FATAL 57P01, carried as a code
const adminShutdown = (): Error =>
  Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });

describe("pool error event", () => {
  let output: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    output = captureStdout();
  });

  afterEach(() => {
    output.restore();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("does not throw when an idle client errors", () => {
    // With no listener, EventEmitter throws the error here, as it did in the pod
    expect(() => pool.emit("error", lostConnection(), {})).not.toThrow();
  });

  it("writes exactly one error line naming the cause", () => {
    pool.emit("error", lostConnection(), {});

    const errors = output.lines().filter((line) => line.level === "error");
    expect(errors).toEqual([
      expect.objectContaining({
        msg: "postgres idle client error",
        error: expect.objectContaining({
          kind: "Error",
          message: "Connection terminated unexpectedly",
        }),
      }),
    ]);
  });

  it("keeps PostgreSQL's error code in the line", () => {
    pool.emit("error", adminShutdown(), {});

    const errors = output.lines().filter((line) => line.level === "error");
    expect(errors).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "57P01" }) }),
    ]);
  });
});
