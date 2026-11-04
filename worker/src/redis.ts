// Same REDIS_HOST and REDIS_PORT as the API (INF-2). BullMQ needs
// maxRetriesPerRequest unset so it can block on the queue.
export const connection = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
};
