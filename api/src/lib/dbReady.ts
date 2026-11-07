import type { Pool } from "pg";
import { START_SERVICES } from "./reachable.js";

// reachable.ts proves that some PostgreSQL answers on the port, not that it is
// the test database: a laptop's own PostgreSQL on 5432 passes that check and
// then refuses the test credentials, which /health reports only as a 503. One
// query before the first test turns that into a message that names the remedy.
// Network errors keep the "start the services" message, so this check is also
// right on its own, without reachable.ts in front of it.

const NETWORK_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EAI_AGAIN",
]);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function requireDatabase(pool: Pool, timeoutMs: number): Promise<void> {
  const { host, port, user, database } = pool.options;
  try {
    await withTimeout(pool.query("SELECT 1"), timeoutMs);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const reason = err instanceof Error ? err.message : String(err);
    if (typeof code === "string" && NETWORK_ERRORS.has(code)) {
      throw new Error(
        `PostgreSQL unreachable at ${host}:${port} (${code}). Start the services first: ${START_SERVICES}`,
      );
    }
    throw new Error(
      `PostgreSQL at ${host}:${port} refused user ${user} on database ${database} (${reason}). ` +
        "Another PostgreSQL is probably listening on that port. Start the test database on a free " +
        `one and point the tests at it, with TEST_DB_PORT=55432 set before both commands: ${START_SERVICES}; npm test`,
    );
  }
}
