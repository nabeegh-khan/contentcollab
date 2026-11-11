import type { EventEmitter } from "node:events";
import { createClient } from "redis";
import { log as writeLog } from "./log.js";

// A state change of the Redis connection as one JSON line (ARCHITECTURE D16)
const logAsJson = (line: string): void => writeLog("warn", line, { component: "redis" });

const DEFAULT_REDIS_PORT = 6379;
const url = `redis://${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? DEFAULT_REDIS_PORT}`;

export const redis = createClient({ url });

/**
 * Logged, not thrown: a dropped Redis connection should show in the logs and
 * in /health, not take the API process down. The client retries about every
 * 2 s while Redis is down, so only the first error of an outage is logged,
 * then "connected" (Redis was down at start) or "connected again" once it is back.
 */
export function logStateChanges(
  client: Pick<EventEmitter, "on">,
  log: (line: string) => void = logAsJson,
) {
  let down = false;
  let connectedBefore = false;
  client.on("error", (err: Error) => {
    if (down) return;
    down = true;
    log(`redis: ${err.message} (retrying; further errors not logged until Redis is back)`);
  });
  client.on("ready", () => {
    if (down) log(connectedBefore ? "redis: connected again" : "redis: connected");
    down = false;
    connectedBefore = true;
  });
}

logStateChanges(redis);

export async function connectRedis(): Promise<void> {
  if (!redis.isOpen) {
    await redis.connect();
  }
}

// Half the readiness probe's 1 s default timeout, leaving room for the Postgres check
const PING_LIMIT_MS = 500;

/**
 * True when Redis answers PONG within PING_LIMIT_MS. While the client is not
 * connected, false at once: a ping would otherwise wait in the offline queue
 * for the 5 s command timeout. Once written to the socket a command has no
 * timeout at all, so a stalled Redis is cut off by the limit here.
 */
export async function pingRedis(
  client: Pick<typeof redis, "isReady" | "ping"> = redis,
): Promise<boolean> {
  if (!client.isReady) return false;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PING_LIMIT_MS);
  });
  const ping = async () => {
    try {
      return (await client.ping()) === "PONG";
    } catch {
      return false;
    }
  };
  try {
    return await Promise.race([ping(), limit]);
  } finally {
    clearTimeout(timer);
  }
}
