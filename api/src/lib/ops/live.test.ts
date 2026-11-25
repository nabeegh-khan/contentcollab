import { describe, expect, it } from "@jest/globals";
import { liveSources, type LiveDeps } from "./live.js";
import { ALERT_QUERIES } from "./alerts.js";
import { DISK_QUERY } from "./disk.js";

// The real reads behind the panel (D31): which Kubernetes paths, which SQL, which Prometheus queries.
const NOW = Date.parse("2026-11-21T19:40:00Z");
const NS = "/api/v1/namespaces/contentcollab";
const APPS = "/apis/apps/v1/namespaces/contentcollab";
const BATCH = "/apis/batch/v1/namespaces/contentcollab";
const PAIR = 2;
const DISK_PERCENT = 12.5;

const pods = {
  items: [
    {
      metadata: { name: "api-a", labels: { app: "api" } },
      spec: { nodeName: "n1" },
      status: {
        phase: "Running",
        startTime: "2026-11-21T19:23:20Z",
        containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }],
      },
    },
    {
      metadata: { name: "api-b", labels: { app: "api" } },
      spec: { nodeName: "n2" },
      status: {
        phase: "Running",
        startTime: "2026-11-21T19:23:20Z",
        containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }],
      },
    },
    {
      metadata: { name: "api-c", labels: { app: "api" } },
      spec: { nodeName: "n2" },
      status: { phase: "Pending" },
    },
  ],
};

function deps(over: Partial<LiveDeps> = {}) {
  const asked: { path: string; text: boolean }[] = [];
  const base: LiveDeps = {
    now: () => NOW,
    hostname: "api-a",
    kubeGet: async (path, options) => {
      asked.push({ path, text: options?.text === true });
      if (path === `${NS}/pods`) return pods;
      if (path.includes("/log"))
        return `{"timestamp":"2026-11-21T19:34:12.796Z","level":"info","msg":"request","http":{"method":"GET","route":"/x","status_code":200},"duration_ms":1.5}\n`;
      if (path.includes("horizontalpodautoscalers")) {
        return {
          spec: { minReplicas: 2, maxReplicas: 5 },
          status: { currentReplicas: 2, desiredReplicas: 2 },
        };
      }
      if (path === "/api/v1/nodes") return { items: [] };
      if (path === "/apis/metrics.k8s.io/v1beta1/nodes") return { items: [] };
      if (path.includes("persistentvolumeclaims")) {
        return {
          status: { phase: "Bound", capacity: { storage: "5Gi" } },
          spec: { storageClassName: "do-block-storage", volumeName: "pvc-1" },
        };
      }
      if (path === `${APPS}/deployments`) {
        return {
          items: [
            {
              spec: { replicas: PAIR, template: { metadata: { labels: { app: "api" } } } },
              status: { readyReplicas: PAIR },
            },
          ],
        };
      }
      if (path === `${APPS}/statefulsets`) return { items: [] };
      if (path === "/api/v1/persistentvolumes/pvc-1") {
        return {
          metadata: { name: "pvc-1" },
          spec: {
            persistentVolumeReclaimPolicy: "Retain",
            storageClassName: "do-block-storage",
            capacity: { storage: "5Gi" },
          },
        };
      }
      if (path === `${BATCH}/cronjobs/db-backup`) {
        return { spec: { schedule: "0 3 * * *" }, status: {} };
      }
      if (path === `${BATCH}/jobs`) return { items: [] };
      if (path.includes("events.k8s.io")) return { items: [] };
      throw new Error(`unexpected path ${path}`);
    },
    query: async () => 1,
    sql: async () => ({ documents: 12, versions: 19, comments: 7 }),
  };
  return { deps: { ...base, ...over }, asked };
}

describe("liveSources", () => {
  it("reads containers from the pod list and marks the pod answering the request", async () => {
    const { deps: d, asked } = deps();
    const out = await liveSources(d).containers?.();
    expect(asked[0]?.path).toBe(`${NS}/pods`);
    expect(out?.find((c) => c.pod === "api-a")?.servingThisRequest).toBe(true);
  });

  it("reads the api HPA, the claim and the events from the exact paths of D31", async () => {
    const { deps: d, asked } = deps();
    const s = liveSources(d);
    await s.hpa?.();
    await s.claim?.();
    await s.events?.();
    expect(asked.map((a) => a.path)).toEqual([
      "/apis/autoscaling/v2/namespaces/contentcollab/horizontalpodautoscalers/api",
      `${NS}/persistentvolumeclaims/data-postgres-0`,
      "/apis/events.k8s.io/v1/namespaces/contentcollab/events?limit=500",
    ]);
  });

  it("reads nodes and their metrics, the metrics from metrics.k8s.io v1beta1", async () => {
    const { deps: d, asked } = deps();
    await liveSources(d).nodes?.();
    expect(asked.map((a) => a.path).sort()).toEqual(
      ["/api/v1/nodes", "/apis/metrics.k8s.io/v1beta1/nodes"].sort(),
    );
  });

  it("reads the log of each READY api pod as text with a line and byte limit", async () => {
    const { deps: d, asked } = deps();
    const out = await liveSources(d).logs?.();
    const logCalls = asked.filter((a) => a.path.includes("/log"));
    expect(logCalls.map((a) => a.path).sort()).toEqual([
      `${NS}/pods/api-a/log?container=api&tailLines=300&limitBytes=131072`,
      `${NS}/pods/api-b/log?container=api&tailLines=300&limitBytes=131072`,
    ]);
    expect(logCalls.every((a) => a.text)).toBe(true);
    expect(out?.lines).toHaveLength(2);
  });

  it("keeps the pods whose log answered when one pod's log read fails", async () => {
    const base = deps().deps;
    const { deps: d } = deps({
      kubeGet: async (path, options) => {
        if (path.includes("/pods/api-b/log")) throw new Error("container is not ready");
        return base.kubeGet!(path, options);
      },
    });
    const out = await liveSources(d).logs?.();
    expect(out?.lines.map((l) => l.pod)).toEqual(["api-a"]);
  });

  it("is an error, not an empty card, when no pod's log could be read at all (the 406 of 24 Nov)", async () => {
    const base = deps().deps;
    const { deps: d } = deps({
      kubeGet: async (path, options) => {
        if (path.includes("/log")) throw new Error("kubernetes API answered 406");
        return base.kubeGet!(path, options);
      },
    });
    await expect(liveSources(d).logs?.()).rejects.toThrow("no pod's log could be read");
  });

  it("asks for the pod list once for the containers and the logs of one snapshot", async () => {
    const { deps: d, asked } = deps();
    const s = liveSources(d);
    await Promise.all([s.containers?.(), s.logs?.()]);
    expect(asked.filter((a) => a.path === `${NS}/pods`)).toHaveLength(1);
  });

  it("puts the drill rows on the events timeline, merged with Kubernetes events by time", async () => {
    const { deps: d } = deps({
      drillRows: async () => [
        {
          requestedAt: "2026-11-21T19:41:02.000Z",
          target: "api",
          pod: "api-old",
          outcome: "evicted",
        },
        {
          requestedAt: "2026-11-21T19:30:00.000Z",
          target: "postgres",
          pod: "postgres-0",
          outcome: null,
        },
      ],
    });
    const events = await liveSources(d).events?.();
    expect(events?.[0]).toMatchObject({
      at: "2026-11-21T19:41:02.000Z",
      type: "Drill",
      reason: "RestartDrill",
      object: "Pod/api-old",
      outcome: "evicted",
      source: "drill",
    });
    expect(events?.[1]).toMatchObject({ outcome: "result not recorded", object: "Pod/postgres-0" });
  });

  it("still shows the drills when the Kubernetes events cannot be read, and the reverse", async () => {
    const base = deps().deps;
    const rows = [
      { requestedAt: "2026-11-21T19:41:02.000Z", target: "api", pod: "p", outcome: "evicted" },
    ];
    const kubeDown = deps({
      drillRows: async () => rows,
      kubeGet: async (path, options) => {
        if (path.includes("events.k8s.io")) throw new Error("denied");
        return base.kubeGet!(path, options);
      },
    }).deps;
    expect(await liveSources(kubeDown).events?.()).toHaveLength(1);
    const dbDown = deps({
      drillRows: async () => {
        throw new Error("db stopping");
      },
    }).deps;
    expect(await liveSources(dbDown).events?.()).toEqual([]);
  });

  it("leaves a source null when its dependency is missing (not in a cluster, no Prometheus)", () => {
    const { deps: d } = deps({ kubeGet: null, query: null });
    const s = liveSources(d);
    expect(s.containers).toBeNull();
    expect(s.hpa).toBeNull();
    expect(s.traffic).toBeNull();
    expect(s.counts).not.toBeNull();
  });

  it("reads the function card with the function it is given, and has none without one (D39)", async () => {
    const card = { configured: false, invocations: [] };
    const { deps: d } = deps({ functionCard: async () => card });
    expect(await liveSources(d).functions?.()).toEqual(card);
    expect(liveSources(deps().deps).functions).toBeUndefined();
  });

  it("reads the queue depth with the function it is given, and has none without one (#30)", async () => {
    const { deps: d } = deps({ queueDepth: async () => 4 });
    expect(await liveSources(d).queue?.()).toBe(4);
    expect(liveSources(deps().deps).queue).toBeUndefined();
  });

  it("counts documents and versions with the sql it is given", async () => {
    const { deps: d } = deps();
    expect(await liveSources(d).counts?.()).toEqual({ documents: 12, versions: 19, comments: 7 });
  });
  it("reads the claim with the name of its volume (D35)", async () => {
    const { deps: d } = deps();
    expect(await liveSources(d).claim?.()).toMatchObject({
      name: "data-postgres-0",
      volumeName: "pvc-1",
    });
  });

  it("reads the desired and ready copies from the Deployments and StatefulSets of the namespace", async () => {
    const { deps: d, asked } = deps();
    const out = await liveSources(d).workloads?.();
    expect(asked.map((a) => a.path).sort()).toEqual([
      `${APPS}/deployments`,
      `${APPS}/statefulsets`,
    ]);
    expect(out).toEqual([{ component: "api", desired: PAIR, ready: PAIR }]);
  });

  it("reads the PersistentVolume that the claim names, not one picked by the code", async () => {
    const { deps: d, asked } = deps();
    const out = await liveSources(d).volume?.();
    expect(asked.map((a) => a.path)).toEqual([
      `${NS}/persistentvolumeclaims/data-postgres-0`,
      "/api/v1/persistentvolumes/pvc-1",
    ]);
    expect(out).toMatchObject({ reclaimPolicy: "Retain" });
  });

  it("is an error, not a guessed policy, when the claim is bound to no volume", async () => {
    const base = deps().deps;
    const { deps: d } = deps({
      kubeGet: async (path, options) =>
        path.includes("persistentvolumeclaims")
          ? { status: { phase: "Pending" }, spec: {} }
          : base.kubeGet!(path, options),
    });
    await expect(liveSources(d).volume?.()).rejects.toThrow("no volume");
  });

  it("reads the db-backup CronJob by name and the Jobs of the namespace", async () => {
    const { deps: d, asked } = deps();
    const out = await liveSources(d).backup?.();
    expect(asked.map((a) => a.path).sort()).toEqual([
      `${BATCH}/cronjobs/db-backup`,
      `${BATCH}/jobs`,
    ]);
    expect(out).toMatchObject({ schedule: "0 3 * * *", lastRun: null });
  });

  it("asks Prometheus for the disk and the alert values with the queries it is tested with", async () => {
    const asked: string[] = [];
    const { deps: d } = deps({
      query: async (q) => {
        asked.push(q);
        return DISK_PERCENT;
      },
    });
    const s = liveSources(d);
    expect(await s.diskUsed?.()).toBe(DISK_PERCENT);
    await s.alerts?.();
    expect(asked).toEqual([DISK_QUERY, ALERT_QUERIES.cpu, ALERT_QUERIES.memory]);
  });

  it("leaves the new sources null without a cluster or without Prometheus", () => {
    const noKube = liveSources(deps({ kubeGet: null }).deps);
    expect(noKube.workloads).toBeNull();
    expect(noKube.volume).toBeNull();
    expect(noKube.backup).toBeNull();
    const noProm = liveSources(deps({ query: null }).deps);
    expect(noProm.diskUsed).toBeNull();
    expect(noProm.alerts).toBeNull();
  });
});
