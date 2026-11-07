import type { Pool } from "pg";
import { START_SERVICES } from "./reachable.js";

// reachable.ts proves that some PostgreSQL answers on the port, not that it is
// the test database: a laptop's own PostgreSQL on 5432 passes that check and
// then refuses the test credentials, which /health reports only as a 503. One
// query before the first test turns that into a message that names the remedy.
export async function requireDatabase(pool: Pool): Promise<void> {
  const { host, port, user, database } = pool.options;
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PostgreSQL at ${host}:${port} refused user ${user} on database ${database} (${reason}). ` +
        "Another PostgreSQL is probably listening on that port. Start the test database on a free " +
        `one and point the tests at it, with TEST_DB_PORT=55432 set before both commands: ${START_SERVICES}; npm test`,
    );
  }
}
