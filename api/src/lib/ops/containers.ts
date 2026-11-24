// The "every container" card of the operations panel (D31): app pods with status, node, restarts and age.
const MS_PER_SECOND = 1000;
const GATEWAY_LABEL = "gateway.networking.k8s.io/gateway-name";
const APPS = ["api", "web", "worker", "postgres", "redis"] as const;
export const COMPONENT_ORDER = [...APPS, "gateway"] as const;

export type Component = (typeof COMPONENT_ORDER)[number];
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
  /** When a container of the pod last stopped to be restarted (the newest of its containers), or null. */
  lastRestartAt: string | null;
  servingThisRequest: boolean;
}

interface ContainerStatus {
  ready?: boolean;
  restartCount?: number;
  lastState?: { terminated?: { finishedAt?: string } };
  state?: { waiting?: { reason?: string } };
}
interface Pod {
  metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string };
  spec?: { nodeName?: string };
  status?: { phase?: string; startTime?: string; containerStatuses?: ContainerStatus[] };
}

/** The part a pod (or a workload's pod template) belongs to, from its labels, or null for anything else. */
export function componentOf(labels: Record<string, string> = {}): Component | null {
  if (labels[GATEWAY_LABEL]) return "gateway";
  return APPS.find((app) => labels.app === app) ?? null;
}

/** The latest of some ISO times, ignoring the missing ones, or null. */
function newest(times: (string | undefined)[]): string | null {
  const known = times.filter((t): t is string => typeof t === "string");
  return known.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
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
        lastRestartAt: newest(statuses.map((c) => c.lastState?.terminated?.finishedAt)),
        servingThisRequest: pod.metadata.name === servingPod,
      },
    ];
  });
  return rows.sort(
    (a, b) =>
      COMPONENT_ORDER.indexOf(a.component) - COMPONENT_ORDER.indexOf(b.component) ||
      a.pod.localeCompare(b.pod),
  );
}
