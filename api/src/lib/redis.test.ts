// Tests for redis.ts while Redis is down: /health's ping fails fast, and errors are logged once per outage (#65).
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { EventEmitter } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { createClient } from "redis";
import { captureStdout } from "./logCapture.js";
import { logStateChanges, pingRedis } from "./redis.js";

// A port that was listening and then closed stands in for Redis being down
let closedPort: number;

beforeAll(async () => {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  closedPort = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
});

// Well under the readiness probe's 1 s default timeout, and far under the client's 5 s command timeout
const FAST_ENOUGH_MS = 500;
// Timer slack on top of pingRedis's 500 ms limit for a busy CI runner; the total stays under the probe's 1 s
const TIMER_SLACK_MS = 300;

describe("pingRedis while Redis is down", () => {
  const down = () => {
    const client = createClient({ url: `redis://127.0.0.1:${closedPort}` });
    client.on("error", () => {}); // the retries are expected here
    return client;
  };
  let client: ReturnType<typeof down>;

  beforeAll(() => {
    client = down();
    // As server.ts does: connect in the background; it does not settle while Redis is down
    const connectInBackground = async () => {
      try {
        await client.connect();
      } catch {
        // destroy() below may end it; nothing to report
      }
    };
    void connectInBackground();
  });

  afterAll(() => {
    client.destroy();
  });

  it("answers false at once instead of waiting in the offline queue for the 5 s command timeout", async () => {
    const started = Date.now();
    const result = await pingRedis(client);
    expect(result).toBe(false);
    expect(Date.now() - started).toBeLessThan(FAST_ENOUGH_MS);
  });
});

describe("pingRedis while Redis is connected but not answering", () => {
  it("answers false within the limit instead of waiting on a written command, which has no timeout", async () => {
    // A connected client whose ping never comes back, as with a paused or partitioned Redis
    const stalled = { isReady: true, ping: () => new Promise<string>(() => {}) };
    const started = Date.now();
    const result = await pingRedis(stalled);
    expect(result).toBe(false);
    expect(Date.now() - started).toBeLessThan(FAST_ENOUGH_MS + TIMER_SLACK_MS);
  });
});

describe("logStateChanges", () => {
  it("logs the first error of an outage, not every retry, and when Redis is back", () => {
    const client = new EventEmitter();
    const lines: string[] = [];
    logStateChanges(client, (line) => lines.push(line));

    client.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    client.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    client.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    client.emit("ready");
    client.emit("error", new Error("Socket closed unexpectedly"));
    client.emit("error", new Error("Socket closed unexpectedly"));
    client.emit("ready");

    expect(lines).toEqual([
      "redis: connect ECONNREFUSED 127.0.0.1:6379 (retrying; further errors not logged until Redis is back)",
      "redis: connected", // Redis was down at start: this is the first connection, not a reconnection
      "redis: Socket closed unexpectedly (retrying; further errors not logged until Redis is back)",
      "redis: connected again",
    ]);
  });
});

describe("logStateChanges default writer", () => {
  it("writes one JSON line per state change, marked as the redis component", () => {
    const out = captureStdout();
    try {
      const client = new EventEmitter();
      logStateChanges(client);
      client.emit("error", new Error("connect ECONNREFUSED"));
      const [line, ...rest] = out.lines();
      expect(rest).toHaveLength(0);
      expect(line?.component).toBe("redis");
      expect(line?.level).toBe("error");
      expect(line?.msg).toContain("redis: connect ECONNREFUSED");
      expect(line?.error?.kind).toBe("Error");
    } finally {
      out.restore();
    }
  });
});

describe("logStateChanges, second review of #55", () => {
  it("names the error code when the message is empty, as Node's AggregateError for localhost is", () => {
    const client = new EventEmitter();
    const lines: string[] = [];
    logStateChanges(client, (line) => lines.push(line));
    client.emit("error", Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }));
    expect(lines).toEqual([
      "redis: ECONNREFUSED (retrying; further errors not logged until Redis is back)",
    ]);
  });

  it("the default writer logs the outage at error with its code, and the reconnection at info", () => {
    const out = captureStdout();
    try {
      const client = new EventEmitter();
      logStateChanges(client);
      const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      client.emit("error", refused);
      client.emit("ready");
      const [down, up] = out.lines();
      expect(down?.level).toBe("error");
      expect(down?.error).toEqual(expect.objectContaining({ kind: "Error", code: "ECONNREFUSED" }));
      expect(up?.level).toBe("info");
      expect(up?.msg).toBe("redis: connected");
    } finally {
      out.restore();
    }
  });
});
