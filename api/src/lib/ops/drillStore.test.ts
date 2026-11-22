import { describe, expect, it } from "@jest/globals";
import { drillStore, nextDrillAt } from "./drillStore.js";

// The database and Redis closures behind the drill (D31), with a fake pool and a fake Redis.
function fakePool(rows: unknown[] = []) {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  return {
    calls,
    pool: {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows };
      },
    },
  };
}

describe("drillStore", () => {
  it("writes the audit row with parameters and returns its id", async () => {
    const { pool, calls } = fakePool([{ id: "d1" }]);
    const id = await drillStore(pool).recordDrill({
      actorUserId: "u1",
      target: "api",
      pod: "api-a",
    });
    expect(id).toBe("d1");
    expect(calls[0]?.text).toMatch(/INSERT INTO ops_drills/);
    expect(calls[0]?.values).toEqual(["u1", "api", "api-a"]);
    expect(calls[0]?.text).not.toContain("api-a");
  });

  it("fails when the insert returns no row, so no eviction is sent", async () => {
    const { pool } = fakePool([]);
    await expect(
      drillStore(pool).recordDrill({ actorUserId: "u1", target: "api", pod: "p" }),
    ).rejects.toThrow();
  });

  it("fills in the outcome by id, with parameters", async () => {
    const { pool, calls } = fakePool();
    await drillStore(pool).finishDrill("d1", "evicted");
    expect(calls[0]?.text).toMatch(/UPDATE ops_drills SET outcome/);
    expect(calls[0]?.values).toEqual(["d1", "evicted"]);
  });

  it("reads the latest ten rows as ISO times", async () => {
    const { pool, calls } = fakePool([
      {
        requested_at: new Date("2026-11-21T19:41:02Z"),
        target: "postgres",
        pod_name: "postgres-0",
        outcome: null,
      },
    ]);
    const rows = await drillStore(pool).drillRows();
    expect(calls[0]?.text).toMatch(/ORDER BY requested_at DESC LIMIT 10/);
    expect(rows).toEqual([
      {
        requestedAt: "2026-11-21T19:41:02.000Z",
        target: "postgres",
        pod: "postgres-0",
        outcome: null,
      },
    ]);
  });
});

describe("nextDrillAt", () => {
  const NOW = Date.parse("2026-11-21T19:40:00Z");
  const redis = (ttl: number, isReady = true) => ({ isReady, ttl: async () => ttl });

  it("adds the lock's remaining seconds to now", async () => {
    expect(await nextDrillAt(redis(42), () => NOW)).toBe("2026-11-21T19:40:42.000Z");
  });

  it("is null when there is no lock (-2), no expiry (-1), or Redis is not ready", async () => {
    expect(await nextDrillAt(redis(-2), () => NOW)).toBeNull();
    expect(await nextDrillAt(redis(-1), () => NOW)).toBeNull();
    expect(await nextDrillAt(redis(30, false), () => NOW)).toBeNull();
  });
});
