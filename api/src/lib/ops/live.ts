// The real reads behind the operations panel (D31): Kubernetes, Prometheus and PostgreSQL, behind small functions.
import { cachedFor, type KubeGet } from "../replicas.js";
import { containersFrom } from "./containers.js";
import { eventsFrom } from "./events.js";
import { hpaFrom } from "./hpa.js";
import { logLinesFrom } from "./logs.js";
import { nodesFrom } from "./nodes.js";
import type { ClaimCard, OpsSources } from "./snapshot.js";
import { trafficFrom, type Query } from "./traffic.js";

const NS = "/api/v1/namespaces/contentcollab";
// A longer tail than the 20 lines shown: the panel's own polling is filtered out afterwards
const LOG_QUERY = "container=api&tailLines=100&limitBytes=65536";
const POD_LIST_SHARED_MS = 1000;
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
  // One pod list per snapshot for the containers card and the log reads, so they agree
  const podList = kubeGet
    ? cachedFor(POD_LIST_SHARED_MS, () => kubeGet(`${NS}/pods`), deps.now)
    : null;
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
            // A pod that stops between the list and the read must not drop the others' lines
            const settled = await Promise.allSettled(
              pods.map(async (pod) => ({
                pod,
                text: String(await kubeGet(`${NS}/pods/${pod}/log?${LOG_QUERY}`, { text: true })),
              })),
            );
            const entries = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
            return logLinesFrom(entries);
          }
        : null,
  };
}
