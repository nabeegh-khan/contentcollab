// The real reads behind the operations panel (D31): Kubernetes, Prometheus and PostgreSQL, behind small functions.
import { cachedFor, type KubeGet } from "../replicas.js";
import { alertsFrom } from "./alerts.js";
import { backupFrom } from "./backup.js";
import { containersFrom } from "./containers.js";
import { diskUsedFrom } from "./disk.js";
import { eventsFrom, type TimelineEvent } from "./events.js";
import type { FunctionsCard } from "./functions.js";
import { hpaFrom } from "./hpa.js";
import { logLinesFrom } from "./logs.js";
import { nodesFrom } from "./nodes.js";
import type { ClaimCard, OpsSources } from "./snapshot.js";
import { trafficFrom, type Query } from "./traffic.js";
import { volumeFrom } from "./volume.js";
import { workloadsFrom } from "./workloads.js";

const NS = "/api/v1/namespaces/contentcollab";
const APPS = "/apis/apps/v1/namespaces/contentcollab";
const BATCH = "/apis/batch/v1/namespaces/contentcollab";
// A longer tail than the lines shown: the panel's own polling, filtered out afterwards, filled a
// 100-line tail within minutes (D35)
const LOG_QUERY = "container=api&tailLines=300&limitBytes=131072";
const POD_LIST_SHARED_MS = 1000;
const CLAIM = "data-postgres-0";

export interface LiveDeps {
  now: () => number;
  /** The name of the pod answering this request (HOSTNAME in a pod). */
  hostname: string;
  kubeGet: KubeGet | null;
  query: Query | null;
  sql: () => Promise<{ documents: number; versions: number; comments: number }>;
  /** The latest rows of ops_drills, for the timeline (D31). */
  drillRows?: (() => Promise<DrillRow[]>) | undefined;
  /** Jobs waiting in the worker's queue (#30). */
  queueDepth?: (() => Promise<number>) | undefined;
  /** When the next drill may start, from the Redis lock. */
  nextDrill?: (() => Promise<string | null>) | undefined;
  /** The serverless function's configuration and last invocations (D39). */
  functionCard?: (() => Promise<FunctionsCard>) | undefined;
}

export interface DrillRow {
  requestedAt: string;
  target: string;
  pod: string;
  outcome: string | null;
}

const toEvent = (row: DrillRow): TimelineEvent => ({
  at: row.requestedAt,
  type: "Drill",
  reason: "RestartDrill",
  object: `Pod/${row.pod}`,
  text: "Restart drill started by an admin",
  outcome: row.outcome ?? "result not recorded",
  source: "drill",
});

function claimFrom(reply: unknown): ClaimCard {
  const claim = reply as {
    status?: { phase?: string; capacity?: { storage?: string } };
    spec?: { storageClassName?: string; volumeName?: string };
  } | null;
  if (!claim || typeof claim.status !== "object" || !claim.status.phase) {
    throw new Error("claim: the reply was not the PersistentVolumeClaim");
  }
  return {
    name: CLAIM,
    phase: claim.status.phase,
    capacity: claim.status.capacity?.storage ?? null,
    storageClass: claim.spec?.storageClassName ?? null,
    volumeName: claim.spec?.volumeName ?? null,
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
    workloads: kubeGet
      ? async () => {
          const [deployments, statefulSets] = await Promise.all([
            kubeGet(`${APPS}/deployments`),
            kubeGet(`${APPS}/statefulsets`),
          ]);
          return workloadsFrom(deployments, statefulSets);
        }
      : null,
    volume: kubeGet
      ? async () => {
          // The volume is the one the claim names: the code never picks a PersistentVolume by itself
          const { volumeName } = claimFrom(await kubeGet(`${NS}/persistentvolumeclaims/${CLAIM}`));
          if (!volumeName) throw new Error("volume: the claim is bound to no volume");
          return volumeFrom(await kubeGet(`/api/v1/persistentvolumes/${volumeName}`));
        }
      : null,
    backup: kubeGet
      ? async () => {
          const [cronJob, jobs] = await Promise.all([
            kubeGet(`${BATCH}/cronjobs/db-backup`),
            kubeGet(`${BATCH}/jobs`),
          ]);
          return backupFrom(cronJob, jobs);
        }
      : null,
    diskUsed: query ? () => diskUsedFrom(query) : null,
    alerts: query ? () => alertsFrom(query) : null,
    counts: deps.sql,
    nextDrill: deps.nextDrill,
    queue: deps.queueDepth,
    functions: deps.functionCard,
    events:
      kubeGet || deps.drillRows
        ? async () => {
            // Kubernetes events and drill rows fail separately: one down still shows the other
            const [kube, drills] = await Promise.allSettled([
              kubeGet
                ? kubeGet("/apis/events.k8s.io/v1/namespaces/contentcollab/events?limit=500").then(
                    eventsFrom,
                  )
                : Promise.resolve([] as TimelineEvent[]),
              deps.drillRows ? deps.drillRows() : Promise.resolve([] as DrillRow[]),
            ]);
            if (kube.status === "rejected" && drills.status === "rejected") throw kube.reason;
            const merged = [
              ...(kube.status === "fulfilled" ? kube.value : []),
              ...(drills.status === "fulfilled" ? drills.value.map(toEvent) : []),
            ];
            return merged.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
          }
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
            // Every read failing is a fault of the source, not a quiet log (the 406 of 24 Nov hid for days)
            if (pods.length > 0 && entries.length === 0) {
              throw new Error("logs: no pod's log could be read");
            }
            return logLinesFrom(entries);
          }
        : null,
  };
}
