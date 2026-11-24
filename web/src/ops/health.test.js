import { describe, expect, it } from "vitest";
import { alertStatus, backupText, healthLines, p95Text } from "./health.js";

// The health summary (D35): four lines computed from the snapshot, each a word (OK, Check or Not
// measured) and a shape, never colour alone. Nothing in the text is typed in.
const GENERATED_AT = "2026-11-24T22:00:00.000Z";

const pod = (component, name, node, over = {}) => ({
  component,
  pod: name,
  status: "Running",
  ready: true,
  node,
  restarts: 0,
  lastRestartAt: null,
  ...over,
});

const containers = [
  pod("api", "api-a", "n1"),
  pod("api", "api-b", "n2"),
  pod("web", "web-a", "n1"),
  pod("web", "web-b", "n2"),
  pod("worker", "worker-a", "n1"),
  pod("postgres", "postgres-0", "n2"),
  pod("redis", "redis-a", "n1"),
  pod("gateway", "gw-a", "n2"),
];
const workloads = [
  { component: "api", desired: 2, ready: 2 },
  { component: "web", desired: 2, ready: 2 },
  { component: "worker", desired: 1, ready: 1 },
  { component: "postgres", desired: 1, ready: 1 },
  { component: "redis", desired: 1, ready: 1 },
  { component: "gateway", desired: 1, ready: 1 },
];
const snapshot = (over = {}) => ({
  generatedAt: GENERATED_AT,
  errors: {},
  containers,
  workloads,
  traffic: {
    requestsPerSecond: 0.4,
    p95Seconds: 0.0077,
    errorPercent: 0,
    errorPercent5m: 0,
    noTraffic: false,
  },
  storage: {
    claim: {
      name: "data-postgres-0",
      phase: "Bound",
      capacity: "5Gi",
      storageClass: "do-block-storage",
    },
    diskUsedPercent: null,
  },
  ...over,
});
const line = (data, key) => healthLines(data).find((l) => l.key === key);

describe("healthLines", () => {
  it("gives four lines in the order of the page, each with a word, a shape and a sentence", () => {
    const lines = healthLines(snapshot());
    expect(lines.map((l) => l.key)).toEqual(["containers", "replicas", "traffic", "disk"]);
    for (const l of lines) {
      expect(l.word).toBeTruthy();
      expect(l.shape).toBeTruthy();
      expect(l.text).toBeTruthy();
    }
  });

  it("counts the running containers and nodes from the snapshot, and the restarts of the last hour", () => {
    const l = line(snapshot(), "containers");
    expect(l).toMatchObject({
      word: "OK",
      text: "8 of 8 running on 2 nodes, 0 restarts in the last hour",
    });
  });

  it("says Check when a container is not running, and counts what it counts", () => {
    const some = containers.map((c, i) =>
      i === 1 ? { ...c, status: "Starting", ready: false } : c,
    );
    const l = line(snapshot({ containers: some }), "containers");
    expect(l.word).toBe("Check");
    expect(l.text).toBe("7 of 8 running on 2 nodes, 0 restarts in the last hour");
  });

  it("counts a container restarted within the hour, and ignores an older restart", () => {
    const recent = containers.map((c, i) =>
      i === 0 ? { ...c, restarts: 1, lastRestartAt: "2026-11-24T21:30:00Z" } : c,
    );
    const hit = line(snapshot({ containers: recent }), "containers");
    expect(hit.word).toBe("Check");
    expect(hit.text).toBe("8 of 8 running on 2 nodes, 1 container restarted in the last hour");
    const old = containers.map((c, i) =>
      i === 0 ? { ...c, restarts: 3, lastRestartAt: "2026-11-24T20:59:00Z" } : c,
    );
    const miss = line(snapshot({ containers: old }), "containers");
    expect(miss.word).toBe("OK");
    expect(miss.text).toContain("0 restarts in the last hour");
  });

  it("says one node, and counts pods that have no node yet as none", () => {
    const one = [pod("api", "api-a", "n1")];
    expect(line(snapshot({ containers: one }), "containers").text).toBe(
      "1 of 1 running on 1 node, 0 restarts in the last hour",
    );
  });

  it("is Not measured, with the reason, when the containers could not be read", () => {
    const l = line(
      snapshot({ containers: null, errors: { containers: "unavailable" } }),
      "containers",
    );
    expect(l).toMatchObject({ word: "Not measured" });
    expect(l.text).toContain("unavailable");
  });

  it("lists ready of desired per part, and is Check when any part has fewer ready than wanted", () => {
    const ok = line(snapshot(), "replicas");
    expect(ok.word).toBe("OK");
    expect(ok.text).toBe("api 2/2, web 2/2, worker 1/1, postgres 1/1, redis 1/1, gateway 1/1");
    const short = workloads.map((w) => (w.component === "api" ? { ...w, ready: 1 } : w));
    const bad = line(snapshot({ workloads: short }), "replicas");
    expect(bad.word).toBe("Check");
    expect(bad.text).toContain("api 1/2");
  });

  it("is Not measured when the workloads could not be read", () => {
    const l = line(snapshot({ workloads: null, errors: { workloads: "unavailable" } }), "replicas");
    expect(l.word).toBe("Not measured");
  });

  it("gives requests per second, errors over 5 minutes and the 95th percentile of the latency", () => {
    const l = line(snapshot(), "traffic");
    expect(l.word).toBe("OK");
    expect(l.text).toBe("0.4 requests/s, 0% errors in the last 5 min, p95 8 ms");
  });

  it("is Check above 1 percent errors or a p95 of a second or more", () => {
    const base = snapshot().traffic;
    expect(line(snapshot({ traffic: { ...base, errorPercent5m: 2.5 } }), "traffic").word).toBe(
      "Check",
    );
    expect(line(snapshot({ traffic: { ...base, p95Seconds: 1.4 } }), "traffic").word).toBe("Check");
    expect(line(snapshot({ traffic: { ...base, errorPercent5m: 1 } }), "traffic").word).toBe("OK");
  });

  it("says so, and is OK, when nothing was requested", () => {
    const quiet = {
      ...snapshot().traffic,
      noTraffic: true,
      requestsPerSecond: 0,
      p95Seconds: null,
      errorPercent5m: null,
    };
    const l = line(snapshot({ traffic: quiet }), "traffic");
    expect(l.word).toBe("OK");
    expect(l.text).toBe("no requests in the last minute, no requests to count in the last 5 min");
  });

  it("is Not measured when Prometheus did not answer", () => {
    const l = line(
      snapshot({ traffic: null, errors: { traffic: "no answer within 1000 ms" } }),
      "traffic",
    );
    expect(l.word).toBe("Not measured");
    expect(l.text).toContain("no answer within 1000 ms");
  });

  it("shows the claim and its size, and says the used space is not measured when Prometheus has no series", () => {
    const l = line(snapshot(), "disk");
    expect(l.word).toBe("OK");
    expect(l.text).toBe("claim data-postgres-0 Bound, 5Gi, used space not measured");
  });

  it("shows the used percent when it is measured, and is Check above the alert threshold", () => {
    const withUsed = (diskUsedPercent) =>
      snapshot({ storage: { ...snapshot().storage, diskUsedPercent } });
    expect(line(withUsed(12.4), "disk").text).toBe("claim data-postgres-0 Bound, 5Gi, 12% used");
    expect(line(withUsed(12.4), "disk").word).toBe("OK");
    expect(line(withUsed(86), "disk").word).toBe("Check");
  });

  it("is Check when the claim is not Bound", () => {
    const pending = {
      ...snapshot().storage,
      claim: { ...snapshot().storage.claim, phase: "Pending" },
    };
    expect(line(snapshot({ storage: pending }), "disk").word).toBe("Check");
  });

  it("is Not measured when the claim could not be read", () => {
    const l = line(
      snapshot({ storage: { claim: null }, errors: { claim: "unavailable" } }),
      "disk",
    );
    expect(l.word).toBe("Not measured");
  });

  it("tells the three words apart by shape, so colour is never the only signal", () => {
    const shapes = new Set([
      line(snapshot(), "containers").shape,
      line(snapshot({ containers: null }), "containers").shape,
      line(snapshot({ workloads: workloads.map((w) => ({ ...w, ready: 0 })) }), "replicas").shape,
    ]);
    expect(shapes.size).toBe(3);
  });
});

describe("p95Text", () => {
  it("writes milliseconds under a second, seconds above, and the top bucket as over 5 s", () => {
    expect(p95Text(0.0077)).toBe("8 ms");
    expect(p95Text(1.26)).toBe("1.3 s");
    expect(p95Text(5)).toBe("over 5 s");
    expect(p95Text(null)).toBe("not measured");
  });
});

describe("alertStatus", () => {
  it("is Not measured without a value, OK up to the threshold and Over above it", () => {
    expect(alertStatus(null, 80).word).toBe("Not measured");
    expect(alertStatus(31, 80).word).toBe("OK");
    expect(alertStatus(80, 80).word).toBe("OK");
    expect(alertStatus(80.5, 80).word).toBe("Over");
  });
});

describe("backupText", () => {
  const generatedAt = Date.parse(GENERATED_AT);
  it("says when the newest run ended and how, against the snapshot's clock", () => {
    const backup = {
      lastSucceededAt: "2026-11-24T08:00:13Z",
      lastRun: { name: "db-backup-1", result: "Succeeded", finishedAt: "2026-11-24T08:00:13Z" },
    };
    expect(backupText(backup, generatedAt)).toBe("succeeded 13 h 59 min ago");
  });

  it("says failed, and when the last success was", () => {
    const backup = {
      lastSucceededAt: "2026-11-23T08:00:13Z",
      lastRun: { name: "db-backup-2", result: "Failed", finishedAt: "2026-11-24T08:15:00Z" },
    };
    expect(backupText(backup, generatedAt)).toBe(
      "FAILED 13 h 45 min ago; last success 37 h 59 min ago",
    );
  });

  it("says running, and no run yet", () => {
    expect(
      backupText(
        { lastSucceededAt: null, lastRun: { name: "x", result: "Running", finishedAt: null } },
        generatedAt,
      ),
    ).toBe("running now");
    expect(backupText({ lastSucceededAt: null, lastRun: null }, generatedAt)).toBe("no run yet");
  });
});
