import { Pool } from "pg";

// One pool for the whole process. Every module imports this instead of
// opening its own connections.
export const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
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
