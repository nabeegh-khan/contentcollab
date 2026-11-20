// Tests that an idle client's error on the shared pool is logged and does not crash the process (ARCHITECTURE D26, #68).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { captureStdout } from "./logCapture.js";
import { pool } from "./db.js";

// What node-postgres passes when PostgreSQL goes away under an idle client
const lostConnection = (): Error => new Error("Connection terminated unexpectedly");

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
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toBe("postgres idle client error");
    expect(errors[0].error).toMatchObject({
      kind: "Error",
      message: "Connection terminated unexpectedly",
    });
  });
});
