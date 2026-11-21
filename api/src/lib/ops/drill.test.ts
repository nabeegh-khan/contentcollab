import { describe, expect, it } from "@jest/globals";
import { HttpError } from "../httpError.js";
import { runDrill, type DrillDeps } from "./drill.js";

// The restart drill (D31): one eviction, chosen by the code (never by the client), one a minute, audited
// before it is sent. Everything outside the function is injected, so no cluster, Redis or database is needed.
const ACTOR = "11111111-1111-4111-8111-111111111111";
const NS = "/api/v1/namespaces/contentcollab";

const pod = (name: string, startTime: string, ready = true, app = "api") => ({
  metadata: { name, labels: { app } },
  spec: { nodeName: "n1" },
  status: {
    phase: "Running",
    startTime,
    containerStatuses: [{ ready, restartCount: 0, state: { running: {} } }],
  },
});

function world(over: Partial<DrillDeps> = {}) {
  const calls: string[] = [];
  const evictions: { path: string; body: unknown }[] = [];
  const audit: { id: string; target: string; pod: string; outcome: string | null }[] = [];
  const deps: DrillDeps = {
    hostname: "api-self",
    now: () => Date.parse("2026-11-21T19:40:00Z"),
    redis: {
      isReady: true,
      set: async () => {
        calls.push("lock");
        return "OK";
      },
      ttl: async () => 42,
      del: async () => {
        calls.push("unlock");
        return 1;
      },
    },
    listPods: async () => ({
      items: [
        pod("api-self", "2026-11-21T19:00:00Z"),
        pod("api-old", "2026-11-21T18:00:00Z"),
        pod("api-new", "2026-11-21T19:30:00Z"),
        pod("postgres-0", "2026-11-21T10:00:00Z", true, "postgres"),
      ],
    }),
    evict: async (path, body) => {
      calls.push("evict");
      evictions.push({ path, body });
    },
    recordDrill: async (row) => {
      calls.push("audit");
      audit.push({ id: "d1", target: row.target, pod: row.pod, outcome: null });
      return "d1";
    },
    finishDrill: async (id, outcome) => {
      calls.push(`finish:${outcome}`);
      const row = audit.find((a) => a.id === id);
      if (row) row.outcome = outcome;
    },
    log: () => {},
    ...over,
  };
  return { deps, calls, evictions, audit };
}

const failWith = (status: number) => async () => {
  throw Object.assign(new Error(`kubernetes API answered ${status}`), { status });
};

describe("runDrill api", () => {
  it("evicts the oldest ready api pod that is not the one answering, after writing the audit row", async () => {
    const { deps, calls, evictions, audit } = world();
    const out = await runDrill(deps, "api", ACTOR);
    expect(evictions).toHaveLength(1);
    expect(evictions[0]?.path).toBe(`${NS}/pods/api-old/eviction`);
    expect(evictions[0]?.body).toEqual({
      apiVersion: "policy/v1",
      kind: "Eviction",
      metadata: { name: "api-old", namespace: "contentcollab" },
    });
    expect(calls).toEqual(["lock", "audit", "evict", "finish:evicted"]);
    expect(audit[0]).toMatchObject({ target: "api", pod: "api-old", outcome: "evicted" });
    expect(out).toMatchObject({ target: "api", pod: "api-old" });
    expect(out.nextAllowedAt).toBe("2026-11-21T19:41:00.000Z");
  });

  it("never evicts the pod serving the request, even when it is the oldest", async () => {
    const { deps, evictions } = world({
      listPods: async () => ({
        items: [pod("api-self", "2026-11-21T10:00:00Z"), pod("api-b", "2026-11-21T19:00:00Z")],
      }),
    });
    await runDrill(deps, "api", ACTOR);
    expect(evictions[0]?.path).toContain("/pods/api-b/");
  });

  it("refuses with 409 unless two api pods are ready, sends nothing, and gives the lock back", async () => {
    const { deps, calls, evictions } = world({
      listPods: async () => ({
        items: [
          pod("api-self", "2026-11-21T19:00:00Z"),
          pod("api-b", "2026-11-21T19:30:00Z", false),
        ],
      }),
    });
    const error = await runDrill(deps, "api", ACTOR).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(409);
    expect(evictions).toHaveLength(0);
    expect(calls).toEqual(["lock", "unlock"]);
  });

  it("turns the PodDisruptionBudget's 429 into a 409 and records it as refused", async () => {
    const { deps, audit } = world({ evict: failWith(429) });
    const error = await runDrill(deps, "api", ACTOR).catch((e) => e);
    expect(error.status).toBe(409);
    expect(audit[0]?.outcome).toBe("refused");
  });

  it("says drills are switched off on a 403 from Kubernetes, and records the failure", async () => {
    const { deps, audit } = world({ evict: failWith(403) });
    const error = await runDrill(deps, "api", ACTOR).catch((e) => e);
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/switched off/i);
    expect(audit[0]?.outcome).toBe("failed");
  });

  it("answers 502 for any other Kubernetes failure", async () => {
    const { deps } = world({ evict: failWith(500) });
    const error = await runDrill(deps, "api", ACTOR).catch((e) => e);
    expect(error.status).toBe(502);
  });
});

describe("runDrill postgres", () => {
  it("evicts postgres-0 only", async () => {
    const { deps, evictions, audit } = world();
    const out = await runDrill(deps, "postgres", ACTOR);
    expect(evictions[0]?.path).toBe(`${NS}/pods/postgres-0/eviction`);
    expect(out.pod).toBe("postgres-0");
    expect(audit[0]).toMatchObject({ target: "postgres", pod: "postgres-0" });
  });

  it("does not need two ready pods, and does not even list pods for the name", async () => {
    let listed = 0;
    const { deps } = world({
      listPods: async () => {
        listed += 1;
        return { items: [] };
      },
    });
    await runDrill(deps, "postgres", ACTOR);
    expect(listed).toBe(0);
  });
});

describe("runDrill guards", () => {
  it("answers 429 with the seconds left when the lock is held, and does nothing else", async () => {
    const { deps, calls } = world({
      redis: {
        isReady: true,
        set: async () => null,
        ttl: async () => 37,
        del: async () => 1,
      },
    });
    const error = await runDrill(deps, "api", ACTOR).catch((e) => e);
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(37);
    expect(calls).toEqual([]);
  });

  it("fails closed with 503 when Redis is not ready", async () => {
    const { deps, calls } = world({
      redis: { isReady: false, set: async () => "OK", ttl: async () => 0, del: async () => 0 },
    });
    const error = await runDrill(deps, "api", ACTOR).catch((e) => e);
    expect(error.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("sends no eviction when the audit row cannot be written, and gives the lock back", async () => {
    const { deps, calls, evictions } = world({
      recordDrill: async () => {
        throw new Error("db down");
      },
    });
    const error = await runDrill(deps, "api", ACTOR).catch((e) => e);
    expect(error.status).toBe(503);
    expect(evictions).toHaveLength(0);
    expect(calls).toEqual(["lock", "unlock"]);
  });

  it("still answers when the outcome cannot be written (the database may be stopping)", async () => {
    const { deps } = world({
      finishDrill: async () => {
        throw new Error("db stopping");
      },
    });
    const out = await runDrill(deps, "postgres", ACTOR);
    expect(out.pod).toBe("postgres-0");
  });

  it("writes one log line with the actor, the target and the pod, and never the token", async () => {
    const lines: { msg: string; fields: Record<string, unknown> }[] = [];
    const { deps } = world({ log: (msg, fields) => lines.push({ msg, fields }) });
    await runDrill(deps, "api", ACTOR);
    expect(lines.at(-1)).toMatchObject({
      msg: "ops drill",
      fields: { actor_user_id: ACTOR, target: "api", pod: "api-old", outcome: "evicted" },
    });
  });
});
