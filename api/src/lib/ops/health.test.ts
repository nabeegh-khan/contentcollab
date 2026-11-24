import { describe, expect, it } from "@jest/globals";
import { workloadsFrom } from "./workloads.js";
import { volumeFrom } from "./volume.js";
import { backupFrom } from "./backup.js";
import { DISK_QUERY, diskUsedFrom } from "./disk.js";
import {
  ALERT_QUERIES,
  ALERT_THRESHOLD_PERCENT,
  ALERT_WINDOW_MINUTES,
  alertsFrom,
} from "./alerts.js";
import { containersFrom } from "./containers.js";

// The core-health sources of D35: small functions that turn Kubernetes and Prometheus replies into cards.
// The replies are shaped like those read from the DOKS cluster on 24 November 2026.
const NOW = Date.parse("2026-11-24T22:00:00Z");
const PAIR = 2;
const TRIO = 3;
const POLICY_THRESHOLD = 80; // percent, the three policies of scripts/alerts.sh
const POLICY_WINDOW = 5; // minutes
const CPU_PERCENT = 31.1;
const MEMORY_PERCENT = 68.8;
const DISK_PERCENT = 12.3;

const workload = (labels: Record<string, string>, replicas: number, ready?: number) => ({
  metadata: { name: "x" },
  spec: { replicas, template: { metadata: { labels } } },
  status: ready === undefined ? {} : { readyReplicas: ready },
});

describe("workloadsFrom", () => {
  it("gives desired and ready copies per part, in the order of the Containers card", () => {
    const deployments = {
      items: [
        workload({ app: "web" }, PAIR, PAIR),
        workload({ app: "api" }, PAIR, 1),
        workload({ app: "worker" }, 1, 1),
        workload({ app: "redis" }, 1, 1),
        workload({ "gateway.networking.k8s.io/gateway-name": "contentcollab" }, 1, 1),
        workload({ app: "something-else" }, TRIO, TRIO),
      ],
    };
    const sets = { items: [workload({ app: "postgres" }, 1, 1)] };
    expect(workloadsFrom(deployments, sets)).toEqual([
      { component: "api", desired: PAIR, ready: 1 },
      { component: "web", desired: PAIR, ready: PAIR },
      { component: "worker", desired: 1, ready: 1 },
      { component: "postgres", desired: 1, ready: 1 },
      { component: "redis", desired: 1, ready: 1 },
      { component: "gateway", desired: 1, ready: 1 },
    ]);
  });

  it("counts a workload with no ready replicas as zero ready, not as missing", () => {
    const out = workloadsFrom({ items: [workload({ app: "api" }, PAIR)] }, { items: [] });
    expect(out).toEqual([{ component: "api", desired: PAIR, ready: 0 }]);
  });

  it("is an error, not an empty list, when a reply is not a list", () => {
    expect(() => workloadsFrom({}, { items: [] })).toThrow("not a list");
    expect(() => workloadsFrom({ items: [] }, null)).toThrow("not a list");
  });
});

describe("containersFrom lastRestartAt", () => {
  const withStatus = (statuses: unknown[]) => ({
    items: [
      {
        metadata: { name: "api-a", labels: { app: "api" } },
        spec: { nodeName: "n1" },
        status: {
          phase: "Running",
          startTime: "2026-11-24T10:00:00Z",
          containerStatuses: statuses,
        },
      },
    ],
  });

  it("is the time the container last stopped, null when it never restarted", () => {
    const never = containersFrom(withStatus([{ ready: true, restartCount: 0 }]), "x", NOW);
    expect(never[0]?.lastRestartAt).toBeNull();
    const once = containersFrom(
      withStatus([
        {
          ready: true,
          restartCount: 1,
          lastState: { terminated: { finishedAt: "2026-11-24T21:30:00Z" } },
        },
      ]),
      "x",
      NOW,
    );
    expect(once[0]?.lastRestartAt).toBe("2026-11-24T21:30:00Z");
  });

  it("takes the newest of several containers", () => {
    const out = containersFrom(
      withStatus([
        {
          ready: true,
          restartCount: 1,
          lastState: { terminated: { finishedAt: "2026-11-24T20:00:00Z" } },
        },
        {
          ready: true,
          restartCount: 1,
          lastState: { terminated: { finishedAt: "2026-11-24T21:00:00Z" } },
        },
      ]),
      "x",
      NOW,
    );
    expect(out[0]?.lastRestartAt).toBe("2026-11-24T21:00:00Z");
  });
});

describe("volumeFrom", () => {
  it("reads the reclaim policy, class and capacity of the PersistentVolume", () => {
    expect(
      volumeFrom({
        metadata: { name: "pvc-6a857bd4" },
        spec: {
          persistentVolumeReclaimPolicy: "Retain",
          storageClassName: "do-block-storage",
          capacity: { storage: "5Gi" },
        },
      }),
    ).toEqual({
      name: "pvc-6a857bd4",
      reclaimPolicy: "Retain",
      storageClass: "do-block-storage",
      capacity: "5Gi",
    });
  });

  it("is an error when the reply is not a PersistentVolume, never a guessed policy", () => {
    expect(() => volumeFrom({ metadata: { name: "x" }, spec: {} })).toThrow("PersistentVolume");
    expect(() => volumeFrom(null)).toThrow("PersistentVolume");
  });
});

const job = (
  name: string,
  created: string,
  status: Record<string, unknown>,
  owner = "db-backup",
) => ({
  metadata: {
    name,
    creationTimestamp: created,
    ownerReferences: [{ kind: "CronJob", name: owner }],
  },
  status,
});
const complete = (at: string) => ({
  completionTime: at,
  conditions: [{ type: "Complete", status: "True", lastTransitionTime: at }],
});
const cronJob = {
  spec: { schedule: "0 3 * * *" },
  status: { lastScheduleTime: "2026-11-24T08:00:00Z", lastSuccessfulTime: "2026-11-24T08:00:13Z" },
};

describe("backupFrom", () => {
  it("gives the schedule, the last scheduled and last successful times, and the newest run's result", () => {
    const jobs = {
      items: [
        job("db-backup-29923680", "2026-11-23T08:00:00Z", complete("2026-11-23T08:00:14Z")),
        job("db-backup-29925120", "2026-11-24T08:00:00Z", complete("2026-11-24T08:00:13Z")),
        job("db-migrate-1", "2026-11-24T09:00:00Z", complete("2026-11-24T09:00:05Z"), "other"),
      ],
    };
    expect(backupFrom(cronJob, jobs)).toEqual({
      schedule: "0 3 * * *",
      lastScheduledAt: "2026-11-24T08:00:00Z",
      lastSucceededAt: "2026-11-24T08:00:13Z",
      lastRun: {
        name: "db-backup-29925120",
        result: "Succeeded",
        finishedAt: "2026-11-24T08:00:13Z",
      },
    });
  });

  it("says Failed when the newest run failed, even though an older one succeeded", () => {
    const failed = {
      conditions: [{ type: "Failed", status: "True", lastTransitionTime: "2026-11-24T08:15:00Z" }],
    };
    const out = backupFrom(cronJob, {
      items: [
        job("db-backup-1", "2026-11-23T08:00:00Z", complete("2026-11-23T08:00:14Z")),
        job("db-backup-2", "2026-11-24T08:00:00Z", failed),
      ],
    });
    expect(out.lastRun).toEqual({
      name: "db-backup-2",
      result: "Failed",
      finishedAt: "2026-11-24T08:15:00Z",
    });
  });

  it("says Running while the newest run has no end condition", () => {
    const out = backupFrom(cronJob, { items: [job("db-backup-3", "2026-11-24T08:00:00Z", {})] });
    expect(out.lastRun).toEqual({ name: "db-backup-3", result: "Running", finishedAt: null });
  });

  it("leaves the times and the run null for a CronJob that has never run", () => {
    const out = backupFrom({ spec: { schedule: "0 3 * * *" }, status: {} }, { items: [] });
    expect(out).toEqual({
      schedule: "0 3 * * *",
      lastScheduledAt: null,
      lastSucceededAt: null,
      lastRun: null,
    });
  });

  it("is an error when a reply is not what it should be", () => {
    expect(() => backupFrom(null, { items: [] })).toThrow("CronJob");
    expect(() => backupFrom(cronJob, {})).toThrow("not a list");
  });
});

describe("diskUsedFrom", () => {
  it("asks for used over capacity of the database claim and returns the percent", async () => {
    const asked: string[] = [];
    const out = await diskUsedFrom(async (q) => {
      asked.push(q);
      return DISK_PERCENT;
    });
    expect(out).toBe(DISK_PERCENT);
    expect(asked).toEqual([DISK_QUERY]);
    expect(DISK_QUERY).toContain("kubelet_volume_stats_used_bytes");
    expect(DISK_QUERY).toContain("kubelet_volume_stats_capacity_bytes");
    expect(DISK_QUERY).toContain('persistentvolumeclaim="data-postgres-0"');
  });

  it("is null, not zero, when Prometheus holds no such series (not measured)", async () => {
    expect(await diskUsedFrom(async () => null)).toBeNull();
  });
});

describe("alertsFrom", () => {
  it("lists CPU, memory and disk against the policies' threshold with Prometheus' current values", async () => {
    const answers = new Map<string, number | null>([
      [ALERT_QUERIES.cpu, CPU_PERCENT],
      [ALERT_QUERIES.memory, MEMORY_PERCENT],
    ]);
    const out = await alertsFrom(async (q) => answers.get(q) ?? null);
    expect(out).toEqual({
      thresholdPercent: POLICY_THRESHOLD,
      windowMinutes: POLICY_WINDOW,
      rows: [
        { metric: "CPU", thresholdPercent: POLICY_THRESHOLD, valuePercent: CPU_PERCENT },
        { metric: "Memory", thresholdPercent: POLICY_THRESHOLD, valuePercent: MEMORY_PERCENT },
        { metric: "Disk", thresholdPercent: POLICY_THRESHOLD, valuePercent: null },
      ],
    });
  });

  it("takes the busiest node, over node usage divided by what Kubernetes can allocate", () => {
    expect(ALERT_QUERIES.cpu).toContain("max(");
    expect(ALERT_QUERIES.cpu).toContain("node_cpu_usage_seconds_total");
    expect(ALERT_QUERIES.cpu).toContain('kube_node_status_allocatable{resource="cpu"}');
    expect(ALERT_QUERIES.memory).toContain("node_memory_working_set_bytes");
    expect(ALERT_QUERIES.memory).toContain('kube_node_status_allocatable{resource="memory"}');
  });

  it("leaves a value null when Prometheus has no answer for it", async () => {
    const out = await alertsFrom(async () => null);
    expect(out.rows.map((r) => r.valuePercent)).toEqual([null, null, null]);
  });
});

describe("the alert thresholds against scripts/alerts.sh", () => {
  // The page says the thresholds match the DigitalOcean policies: this fails if the script changes
  it("are the script's value and window, for the same three metrics", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const script = readFileSync(
      fileURLToPath(new URL("../../../../scripts/alerts.sh", import.meta.url)),
      "utf8",
    );
    expect(ALERT_THRESHOLD_PERCENT).toBe(POLICY_THRESHOLD);
    expect(ALERT_WINDOW_MINUTES).toBe(POLICY_WINDOW);
    expect(script).toContain(`--value ${POLICY_THRESHOLD} --window ${POLICY_WINDOW}m`);
    expect(script).toContain("ensure v1/insights/droplet/cpu ");
    expect(script).toContain("ensure v1/insights/droplet/memory_utilization_percent ");
    expect(script).toContain("ensure v1/insights/droplet/disk_utilization_percent ");
    expect(script).toContain("above 80% for 5 minutes");
  });
});
