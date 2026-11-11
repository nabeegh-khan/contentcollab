import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { captureStdout } from "./logCapture.js";
import { logListening, logRedisGaveUp } from "./startup.js";

// The two lines server.ts writes outside a request are JSON too, so the whole
// standard output of the API can be parsed (OBS-1, ARCHITECTURE D16)
const PORT = 3000;

let out: ReturnType<typeof captureStdout>;
beforeEach(() => {
  delete process.env.LOG_LEVEL;
  out = captureStdout();
});
afterEach(() => out.restore());

describe("startup lines", () => {
  it("says the API is listening as one info line with the port", () => {
    logListening(PORT);
    expect(out.lines()).toEqual([
      expect.objectContaining({ level: "info", msg: "api listening", port: PORT }),
    ]);
  });

  it("says the Redis client gave up as one error line with the error", () => {
    logRedisGaveUp(new Error("retries exhausted"));
    const [line, ...rest] = out.lines();
    expect(rest).toEqual([]);
    expect(line?.level).toBe("error");
    expect(line?.component).toBe("redis");
    expect(line?.msg).toBe(
      "redis: client stopped retrying; /health reports Redis down until the API restarts",
    );
    expect(line?.error?.message).toBe("retries exhausted");
  });
});
