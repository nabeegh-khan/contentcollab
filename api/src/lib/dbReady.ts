import { Client, type Pool } from "pg";
import { START_SERVICES } from "./reachable.js";

// reachable.ts proves that some PostgreSQL answers on the port, not that it is
// the test database: a laptop's own PostgreSQL on 5432 passes that check and
// then refuses the test credentials, which /health reports only as a 503. One
// query before the first test turns that into a message that names the remedy.
// Network errors and timeouts keep the "start the services" message, so this
// check is also right on its own, without reachable.ts in front of it.

const NETWORK_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EAI_AGAIN",
]);

// pg's own timeout errors carry no code (pg 8.23, lib/client.js)
const PG_TIMEOUTS = new Set(["timeout expired", "Query read timeout"]);

export async function requireDatabase(pool: Pool, timeoutMs: number): Promise<void> {
  const { host, port, user, database } = pool.options;
  // A client of its own with pg's timeouts, so a server that accepts the
  // connection and never answers is given up by pg itself and nothing is left
  // pending in the pool (pool.end() must still return at once afterwards).
  const client = new Client({
    ...pool.options,
    password: pool.options.password, // non-enumerable in pg-pool, so the spread drops it
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const reason = err instanceof Error ? err.message : String(err);
    if ((typeof code === "string" && NETWORK_ERRORS.has(code)) || PG_TIMEOUTS.has(reason)) {
      const why = typeof code === "string" ? code : reason;
      throw new Error(
        `PostgreSQL unreachable at ${host}:${port} (${why}). Start the services first: ${START_SERVICES}`,
      );
    }
    throw new Error(
      `PostgreSQL at ${host}:${port} refused user ${user} on database ${database} (${reason}). ` +
        "Another PostgreSQL is probably listening on that port. Start the test database on a free " +
        `one and point the tests at it, with TEST_DB_PORT=55432 set before both commands: ${START_SERVICES}; npm test`,
    );
  } finally {
    // A no-op when the connect never completed (pg Client.end)
    await client.end().catch(() => undefined);
  }
}
