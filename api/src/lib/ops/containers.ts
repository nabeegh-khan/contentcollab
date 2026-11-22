// The "every container" card of the operations panel (D31): app pods with status, node, restarts and age.
const MS_PER_SECOND = 1000;
const GATEWAY_LABEL = "gateway.networking.k8s.io/gateway-name";
const APPS = ["api", "web", "worker", "postgres", "redis"] as const;
const ORDER = [...APPS, "gateway"] as const;

export type Component = (typeof ORDER)[number];
export type Status = "Running" | "Starting" | "Stopping" | "Restarting" | "Failed" | "Unknown";

export interface Container {
  component: Component;
  pod: string;
  status: Status;
  ready: boolean;
  node: string | null;
  restarts: number;
  startedAt: string | null;
  ageSeconds: number | null;
  servingThisRequest: boolean;
}

interface ContainerStatus {
  ready?: boolean;
  restartCount?: number;
  state?: { waiting?: { reason?: string } };
}
interface Pod {
  metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string };
  spec?: { nodeName?: string };
  status?: { phase?: string; startTime?: string; containerStatuses?: ContainerStatus[] };
}

function componentOf(labels: Record<string, string> = {}): Component | null {
  if (labels[GATEWAY_LABEL]) return "gateway";
  return APPS.find((app) => labels.app === app) ?? null;
}

function statusOf(pod: Pod, ready: boolean): Status {
  if (pod.metadata.deletionTimestamp) return "Stopping";
  const containers = pod.status?.containerStatuses ?? [];
  if (containers.some((c) => c.state?.waiting?.reason === "CrashLoopBackOff")) return "Restarting";
  const phase = pod.status?.phase;
  if (phase === "Running" && ready) return "Running";
  if (phase === "Pending" || phase === "Running") return "Starting";
  return phase === "Failed" ? "Failed" : "Unknown";
}

/** The panel's rows, in the order api, web, worker, postgres, redis, gateway, then by pod name. */
export function containersFrom(list: unknown, servingPod: string, nowMs: number): Container[] {
  const items = (list as { items?: Pod[] } | null)?.items;
  if (!Array.isArray(items)) throw new Error("pods: the reply was not a pod list");
  const rows = items.flatMap((pod): Container[] => {
    const component = componentOf(pod.metadata.labels);
    if (!component) return [];
    const statuses = pod.status?.containerStatuses ?? [];
    const ready = statuses.length > 0 && statuses.every((c) => c.ready === true);
    const startedAt = pod.status?.startTime ?? null;
    return [
      {
        component,
        pod: pod.metadata.name,
        status: statusOf(pod, ready),
        ready,
        node: pod.spec?.nodeName ?? null,
        restarts: statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
        startedAt,
        ageSeconds: startedAt ? Math.round((nowMs - Date.parse(startedAt)) / MS_PER_SECOND) : null,
        servingThisRequest: pod.metadata.name === servingPod,
      },
    ];
  });
  return rows.sort(
    (a, b) => ORDER.indexOf(a.component) - ORDER.indexOf(b.component) || a.pod.localeCompare(b.pod),
  );
}
