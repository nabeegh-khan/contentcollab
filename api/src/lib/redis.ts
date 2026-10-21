import { createClient } from "redis";

const url = `redis://${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? 6379}`;

export const redis = createClient({ url });

// Logged, not thrown: a dropped Redis connection should show in the logs and
// in /health, not take the API process down.
redis.on("error", (err) => console.error("redis:", err.message));

export async function connectRedis(): Promise<void> {
  if (!redis.isOpen) {
    await redis.connect();
  }
}

export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}
