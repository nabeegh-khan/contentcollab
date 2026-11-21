import { describe, expect, it } from "@jest/globals";
import { parseCpuMillicores, parseMemoryMiB } from "./quantity.js";
import { containersFrom } from "./containers.js";
import { hpaFrom } from "./hpa.js";
import { nodesFrom } from "./nodes.js";
import { eventsFrom } from "./events.js";
import { logLinesFrom } from "./logs.js";

// The operations panel (D31): small functions that turn Kubernetes replies into the panel's cards.
// The replies are shaped like those read from the DOKS cluster on 21 November 2026.
const NOW = Date.parse("2026-11-21T19:40:00Z");

describe("quantities", () => {
  it("reads CPU as millicores from cores, millicores and nanocores", () => {
    expect(parseCpuMillicores("2")).toBe(2000);
    expect(parseCpuMillicores("1900m")).toBe(1900);
    expect(parseCpuMillicores("253000000n")).toBe(253);
  });

  it("reads memory as MiB from Ki, Mi, Gi and bytes", () => {
    expect(parseMemoryMiB("3074892Ki")).toBe(3003);
    expect(parseMemoryMiB("1626Mi")).toBe(1626);
    expect(parseMemoryMiB("3Gi")).toBe(3072);
    expect(parseMemoryMiB("1048576")).toBe(1);
  });

  it("rejects a quantity it cannot read instead of guessing", () => {
    expect(() => parseCpuMillicores("lots")).toThrow();
    expect(() => parseMemoryMiB("12 parsecs")).toThrow();
  });
});

function pod(name: string, extra: Record<string, unknown> = {}) {
  return {
    metadata: { name, labels: { app: "api" }, ...((extra.metadata as object) ?? {}) },
    spec: { nodeName: "default-3aodxs" },
    status: {
      phase: "Running",
      startTime: "2026-11-21T19:23:20Z",
      containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }],
      ...((extra.status as object) ?? {}),
    },
  };
}

describe("containersFrom", () => {
  it("lists the app pods with status, node, restarts and age, and marks the one serving", () => {
    const list = {
      items: [
        pod("web-1", { metadata: { labels: { app: "web" } } }),
        pod("api-b"),
        pod("api-a"),
        pod("db-migrate-1", { metadata: { labels: { "job-name": "db-migrate-1" } } }),
        pod("gw-1", {
          metadata: { labels: { "gateway.networking.k8s.io/gateway-name": "contentcollab" } },
        }),
      ],
    };
    const out = containersFrom(list, "api-b", NOW);
    expect(out.map((c) => `${c.component}:${c.pod}`)).toEqual([
      "api:api-a",
      "api:api-b",
      "web:web-1",
      "gateway:gw-1",
    ]);
    const b = out.find((c) => c.pod === "api-b");
    expect(b).toMatchObject({
      status: "Running",
      ready: true,
      node: "default-3aodxs",
      restarts: 0,
      startedAt: "2026-11-21T19:23:20Z",
      ageSeconds: 1000,
      servingThisRequest: true,
    });
    expect(out.find((c) => c.pod === "api-a")?.servingThisRequest).toBe(false);
  });

  it("says Stopping, Restarting, Starting and the phase in plain words", () => {
    const status = (
      extra: Record<string, unknown>,
      meta: Record<string, unknown> = {},
    ): string | undefined => {
      const p = pod("api-x", { status: extra, metadata: meta });
      return containersFrom({ items: [p] }, "", NOW)[0]?.status;
    };
    expect(status({}, { deletionTimestamp: "2026-11-21T19:39:00Z" })).toBe("Stopping");
    expect(
      status({
        containerStatuses: [
          { ready: false, restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      }),
    ).toBe("Restarting");
    expect(
      status({ containerStatuses: [{ ready: false, restartCount: 0, state: { running: {} } }] }),
    ).toBe("Starting");
    expect(status({ phase: "Pending", containerStatuses: undefined })).toBe("Starting");
    expect(status({ phase: "Failed" })).toBe("Failed");
    expect(status({ phase: "Unknown" })).toBe("Unknown");
  });

  it("sums restarts over containers", () => {
    const p = pod("api-x", {
      status: {
        containerStatuses: [
          { ready: true, restartCount: 2, state: { running: {} } },
          { ready: true, restartCount: 3, state: { running: {} } },
        ],
      },
    });
    expect(containersFrom({ items: [p] }, "", NOW)[0]?.restarts).toBe(5);
  });

  it("is an error, not an empty list, when the reply is not a pod list", () => {
    expect(() => containersFrom({ kind: "Status", status: "Failure" }, "", NOW)).toThrow();
  });
});

describe("hpaFrom", () => {
  const hpa = {
    spec: {
      minReplicas: 2,
      maxReplicas: 5,
      metrics: [
        { type: "Resource", resource: { name: "cpu", target: { averageUtilization: 70 } } },
      ],
    },
    status: {
      currentReplicas: 2,
      desiredReplicas: 2,
      lastScaleTime: "2026-11-21T19:18:01Z",
      currentMetrics: [
        { type: "Resource", resource: { name: "cpu", current: { averageUtilization: 12 } } },
      ],
      conditions: [
        { type: "AbleToScale", status: "True", reason: "ReadyForNewScale" },
        { type: "ScalingLimited", status: "True", reason: "TooFewReplicas" },
      ],
    },
  };

  it("reads replicas, CPU against target, last scale time and what limits it", () => {
    expect(hpaFrom(hpa)).toEqual({
      name: "api",
      currentReplicas: 2,
      desiredReplicas: 2,
      minReplicas: 2,
      maxReplicas: 5,
      cpuPercent: 12,
      cpuTargetPercent: 70,
      lastScaleTime: "2026-11-21T19:18:01Z",
      limitedBy: "TooFewReplicas",
    });
  });

  it("leaves CPU and limit null when the HPA cannot read them yet", () => {
    const out = hpaFrom({
      spec: hpa.spec,
      status: { currentReplicas: 2, desiredReplicas: 2, conditions: [] },
    });
    expect(out).toMatchObject({ cpuPercent: null, limitedBy: null, lastScaleTime: null });
  });
});

describe("nodesFrom", () => {
  const nodes = {
    items: [
      { metadata: { name: "n1" }, status: { allocatable: { cpu: "1900m", memory: "3074892Ki" } } },
    ],
  };
  const metrics = {
    items: [
      {
        metadata: { name: "n1" },
        timestamp: "2026-11-21T19:35:45Z",
        window: "10.037s",
        usage: { cpu: "253000000n", memory: "1664568Ki" },
      },
    ],
  };

  it("gives CPU and memory as a percent of allocatable, as kubectl top does", () => {
    expect(nodesFrom(nodes, metrics)).toEqual([
      {
        name: "n1",
        cpuPercent: 13,
        memoryPercent: 54,
        cpuMillicores: 253,
        cpuAllocatableMillicores: 1900,
        memoryMiB: 1626,
        memoryAllocatableMiB: 3003,
        sampledAt: "2026-11-21T19:35:45Z",
        windowSeconds: 10,
      },
    ]);
  });

  it("skips a node that has no metrics yet", () => {
    expect(nodesFrom(nodes, { items: [] })).toEqual([]);
  });
});

describe("eventsFrom", () => {
  const hpaEvent = {
    regarding: { kind: "HorizontalPodAutoscaler", name: "api" },
    reason: "SuccessfulRescale",
    note: "New size: 3; reason: cpu resource utilization (percentage of request) above target",
    type: "Normal",
    eventTime: null,
    deprecatedLastTimestamp: "2026-11-21T19:09:30Z",
    deprecatedCount: 1,
  };

  it("takes the time of an HPA event from deprecatedLastTimestamp when eventTime is null", () => {
    const [e] = eventsFrom({ items: [hpaEvent] });
    expect(e).toMatchObject({
      at: "2026-11-21T19:09:30Z",
      type: "Normal",
      reason: "SuccessfulRescale",
      object: "HorizontalPodAutoscaler/api",
      count: 1,
      source: "kubernetes",
    });
    expect(e?.text).toContain("New size: 3");
  });

  it("prefers a series' last time, keeps only the panel's reasons, newest first, 30 at most", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      regarding: { kind: "Pod", name: `p${i}` },
      reason: "Started",
      note: "started",
      type: "Normal",
      eventTime: `2026-11-21T19:${String(i).padStart(2, "0")}:00.000000Z`,
    }));
    const noise = { ...many[0], reason: "Pulled" };
    const series = {
      ...many[0],
      reason: "BackOff",
      eventTime: "2026-11-21T10:00:00.000000Z",
      series: { lastObservedTime: "2026-11-21T19:59:00.000000Z", count: 7 },
    };
    const out = eventsFrom({ items: [...many, noise, series] });
    expect(out).toHaveLength(30);
    expect(out[0]).toMatchObject({
      reason: "BackOff",
      count: 7,
      at: "2026-11-21T19:59:00.000000Z",
    });
    expect(out.every((e) => e.reason !== "Pulled")).toBe(true);
    const times = out.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("cuts a note to 200 characters and skips an event with no time at all", () => {
    const long = { ...hpaEvent, note: "x".repeat(500) };
    const none = { ...hpaEvent, deprecatedLastTimestamp: undefined };
    const out = eventsFrom({ items: [long, none] });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toHaveLength(200);
  });
});

describe("logLinesFrom", () => {
  const request = (route: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      timestamp: "2026-11-21T19:34:12.796Z",
      level: "info",
      msg: "request",
      http: { request_id: "r1", method: "POST", route, status_code: 201 },
      duration_ms: 30.91,
      ...extra,
    });

  it("keeps only the named fields of request lines, labelled with the pod", () => {
    const out = logLinesFrom([{ pod: "api-a", text: `${request("/api/v1/documents")}\n` }]);
    expect(out.lines).toEqual([
      {
        at: "2026-11-21T19:34:12.796Z",
        pod: "api-a",
        level: "info",
        msg: "request",
        method: "POST",
        route: "/api/v1/documents",
        status: 201,
        durationMs: 30.91,
      },
    ]);
    expect(out.hidden).toBe(0);
  });

  it("never shows another field, such as an error stack or a request id", () => {
    const line = request("/api/v1/documents", {
      error: { message: "password authentication failed for user", stack: "at db.ts" },
    });
    const text = JSON.stringify(logLinesFrom([{ pod: "api-a", text: line }]));
    expect(text).not.toContain("password");
    expect(text).not.toContain("stack");
    expect(text).not.toContain("r1");
  });

  it("counts a line that is not JSON as hidden and drops the panel's own polling", () => {
    const text = [
      "status: queue failed: connect ECONNREFUSED 10.0.0.5:6379",
      request("/api/v1/ops"),
      request("/api/v1/status"),
      request("/api/v1/documents"),
    ].join("\n");
    const out = logLinesFrom([{ pod: "api-a", text }]);
    expect(out.lines).toHaveLength(1);
    expect(out.hidden).toBe(1);
  });

  it("merges pods by time, newest 20, and cuts values to 200 characters", () => {
    const at = (s: number) => `2026-11-21T19:34:${String(s).padStart(2, "0")}.000Z`;
    const lines = (pod: string, from: number) => ({
      pod,
      text: Array.from({ length: 15 }, (_, i) =>
        request("/r" + "x".repeat(300), { timestamp: at(from + i * 2) }),
      ).join("\n"),
    });
    const out = logLinesFrom([lines("api-a", 0), lines("api-b", 1)]);
    expect(out.lines).toHaveLength(20);
    expect(out.lines[0]?.route).toHaveLength(200);
    const times = out.lines.map((l) => Date.parse(l.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(out.lines.at(-1)?.at).toBe(at(29));
  });
});
