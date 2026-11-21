import { describe, expect, it } from "@jest/globals";
import { liveSources, type LiveDeps } from "./live.js";

// The real reads behind the panel (D31): which Kubernetes paths, which SQL, which Prometheus queries.
const NOW = Date.parse("2026-11-21T19:40:00Z");
const NS = "/api/v1/namespaces/contentcollab";

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
          spec: { storageClassName: "do-block-storage" },
        };
      }
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
      `${NS}/pods/api-a/log?container=api&tailLines=100&limitBytes=65536`,
      `${NS}/pods/api-b/log?container=api&tailLines=100&limitBytes=65536`,
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

  it("asks for the pod list once for the containers and the logs of one snapshot", async () => {
    const { deps: d, asked } = deps();
    const s = liveSources(d);
    await Promise.all([s.containers?.(), s.logs?.()]);
    expect(asked.filter((a) => a.path === `${NS}/pods`)).toHaveLength(1);
  });

  it("leaves a source null when its dependency is missing (not in a cluster, no Prometheus)", () => {
    const { deps: d } = deps({ kubeGet: null, query: null });
    const s = liveSources(d);
    expect(s.containers).toBeNull();
    expect(s.hpa).toBeNull();
    expect(s.traffic).toBeNull();
    expect(s.counts).not.toBeNull();
  });

  it("counts documents and versions with the sql it is given", async () => {
    const { deps: d } = deps();
    expect(await liveSources(d).counts?.()).toEqual({ documents: 12, versions: 19, comments: 7 });
  });
});
