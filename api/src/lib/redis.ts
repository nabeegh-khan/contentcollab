import type { EventEmitter } from "node:events";
import { createClient } from "redis";

const url = `redis://${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? 6379}`;

export const redis = createClient({ url });

/**
 * Logged, not thrown: a dropped Redis connection should show in the logs and
 * in /health, not take the API process down. The client retries about every
 * 2 s while Redis is down, so only the first error of an outage is logged,
 * and "connected again" once it is back.
 */
export function logStateChanges(client: Pick<EventEmitter, "on">, log: (line: string) => void = console.error) {
  let down = false;
  client.on("error", (err: Error) => {
    if (down) return;
    down = true;
    log(`redis: ${err.message} (retrying; further errors not logged until Redis is back)`);
  });
  client.on("ready", () => {
    if (!down) return;
    down = false;
    log("redis: connected again");
  });
}

logStateChanges(redis);

export async function connectRedis(): Promise<void> {
  if (!redis.isOpen) {
    await redis.connect();
  }
}

export async function pingRedis(client: Pick<typeof redis, "isReady" | "ping"> = redis): Promise<boolean> {
  try {
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  }
}
