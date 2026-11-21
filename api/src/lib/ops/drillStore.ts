// The database and Redis reads behind the restart drill (D31), as small functions that take their client.
import type { DrillRow } from "./live.js";
import type { DrillTarget, Outcome } from "./drill.js";

const LOCK_KEY = "ops:drill:lock";
const MS_PER_SECOND = 1000;

interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export function drillStore(pool: Queryable) {
  return {
    /** Writes the audit row, with parameters, and returns its id; rejects if no row came back. */
    async recordDrill(row: {
      actorUserId: string;
      target: DrillTarget;
      pod: string;
    }): Promise<string> {
      const { rows } = await pool.query(
        "INSERT INTO ops_drills (actor_user_id, target, pod_name) VALUES ($1, $2, $3) RETURNING id",
        [row.actorUserId, row.target, row.pod],
      );
      const id = (rows[0] as { id?: string } | undefined)?.id;
      if (!id) throw new Error("the drill row was not written");
      return id;
    },
    async finishDrill(id: string, outcome: Outcome): Promise<void> {
      await pool.query("UPDATE ops_drills SET outcome = $2 WHERE id = $1", [id, outcome]);
    },
    /** The latest ten drills, newest first, for the events timeline. */
    async drillRows(): Promise<DrillRow[]> {
      const { rows } = await pool.query(
        "SELECT requested_at, target, pod_name, outcome FROM ops_drills ORDER BY requested_at DESC LIMIT 10",
      );
      return (
        rows as { requested_at: Date; target: string; pod_name: string; outcome: string | null }[]
      ).map((r) => ({
        requestedAt: r.requested_at.toISOString(),
        target: r.target,
        pod: r.pod_name,
        outcome: r.outcome,
      }));
    },
  };
}

/** When the next drill may start: now plus the lock's remaining seconds, or null (no lock, no expiry, Redis down). */
export async function nextDrillAt(
  redis: { isReady: boolean; ttl: (key: string) => Promise<number> },
  now: () => number = Date.now,
): Promise<string | null> {
  if (!redis.isReady) return null;
  const seconds = await redis.ttl(LOCK_KEY);
  return seconds > 0 ? new Date(now() + seconds * MS_PER_SECOND).toISOString() : null;
}
