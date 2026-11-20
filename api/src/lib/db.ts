import { Pool } from "pg";
import { errorFields, log } from "./log.js";

// PostgreSQL's default port, used when DB_PORT is not set
const DEFAULT_PG_PORT = 5432;

// One pool for the whole process. Every module imports this instead of
// opening its own connections.
export const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? DEFAULT_PG_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// An idle client whose server went away emits "error" through the pool. With
// no listener Node throws it and the process exits (ARCHITECTURE D26, #68).
// The pool has already removed that client and the next query opens a new one,
// so the error is only logged; readiness keeps traffic away meanwhile.
// PostgreSQL's code (57P01 when the server is shut down) is kept, as redis.ts does.
pool.on("error", (err) => {
  const code = (err as { code?: unknown }).code;
  log("error", "postgres idle client error", {
    error: { ...errorFields(err), ...(typeof code === "string" ? { code } : {}) },
  });
});

// Used by /health and by readiness: a trivial query proves the connection works.
export async function pingPostgres(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
