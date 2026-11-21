// The real reads behind the operations panel (D31): Kubernetes, Prometheus and PostgreSQL, behind small functions.
import type { KubeGet } from "../replicas.js";
import { containersFrom } from "./containers.js";
import { eventsFrom } from "./events.js";
import { hpaFrom } from "./hpa.js";
import { logLinesFrom } from "./logs.js";
import { nodesFrom } from "./nodes.js";
import type { ClaimCard, OpsSources } from "./snapshot.js";
import { trafficFrom, type Query } from "./traffic.js";

const NS = "/api/v1/namespaces/contentcollab";
const LOG_QUERY = "container=api&tailLines=20&limitBytes=65536";
const CLAIM = "data-postgres-0";

export interface LiveDeps {
  now: () => number;
  /** The name of the pod answering this request (HOSTNAME in a pod). */
  hostname: string;
  kubeGet: KubeGet | null;
  query: Query | null;
  sql: () => Promise<{ documents: number; versions: number }>;
}

function claimFrom(reply: unknown): ClaimCard {
  const claim = reply as {
    status?: { phase?: string; capacity?: { storage?: string } };
    spec?: { storageClassName?: string };
  } | null;
  if (!claim || typeof claim.status !== "object" || !claim.status.phase) {
    throw new Error("claim: the reply was not the PersistentVolumeClaim");
  }
  return {
    name: CLAIM,
    phase: claim.status.phase,
    capacity: claim.status.capacity?.storage ?? null,
    storageClass: claim.spec?.storageClassName ?? null,
  };
}

/** Ready API pods that are not being stopped, from a pod list. */
function readyApiPods(list: unknown, nowMs: number, hostname: string): string[] {
  return containersFrom(list, hostname, nowMs)
    .filter((c) => c.component === "api" && c.ready && c.status === "Running")
    .map((c) => c.pod);
}

export function liveSources(deps: LiveDeps): OpsSources {
  const { kubeGet, query } = deps;
  const podList = kubeGet ? () => kubeGet(`${NS}/pods`) : null;
  return {
    containers: podList
      ? async () => containersFrom(await podList(), deps.hostname, deps.now())
      : null,
    hpa: kubeGet
      ? async () =>
          hpaFrom(
            await kubeGet(
              "/apis/autoscaling/v2/namespaces/contentcollab/horizontalpodautoscalers/api",
            ),
          )
      : null,
    nodes: kubeGet
      ? async () => {
          const [nodes, metrics] = await Promise.all([
            kubeGet("/api/v1/nodes"),
            kubeGet("/apis/metrics.k8s.io/v1beta1/nodes"),
          ]);
          return nodesFrom(nodes, metrics);
        }
      : null,
    traffic: query ? () => trafficFrom(query) : null,
    claim: kubeGet
      ? async () => claimFrom(await kubeGet(`${NS}/persistentvolumeclaims/${CLAIM}`))
      : null,
    counts: deps.sql,
    events: kubeGet
      ? async () =>
          eventsFrom(
            await kubeGet("/apis/events.k8s.io/v1/namespaces/contentcollab/events?limit=500"),
          )
      : null,
    logs:
      kubeGet && podList
        ? async () => {
            const pods = readyApiPods(await podList(), deps.now(), deps.hostname);
            const entries = await Promise.all(
              pods.map(async (pod) => ({
                pod,
                text: String(await kubeGet(`${NS}/pods/${pod}/log?${LOG_QUERY}`, { text: true })),
              })),
            );
            return logLinesFrom(entries);
          }
        : null,
  };
}
