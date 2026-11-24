// Desired and ready copies per part (D35): the health summary's "api 2/2" lines. A pod list cannot give
// the desired count, so this reads the Deployments and StatefulSets and matches each to a part by the
// labels of its pod template, as the pods carry them.
import { COMPONENT_ORDER, componentOf, type Component } from "./containers.js";

export interface Workload {
  component: Component;
  desired: number;
  ready: number;
}

interface Item {
  spec?: { replicas?: number; template?: { metadata?: { labels?: Record<string, string> } } };
  status?: { readyReplicas?: number };
}

function itemsOf(reply: unknown): Item[] {
  const items = (reply as { items?: Item[] } | null)?.items;
  if (!Array.isArray(items)) throw new Error("workloads: the reply was not a list");
  return items;
}

/** One row per part that has a workload, in the order of the Containers card; other workloads are left out. */
export function workloadsFrom(deployments: unknown, statefulSets: unknown): Workload[] {
  const items = [...itemsOf(deployments), ...itemsOf(statefulSets)];
  return COMPONENT_ORDER.flatMap((component): Workload[] => {
    const mine = items.filter(
      (item) => componentOf(item.spec?.template?.metadata?.labels) === component,
    );
    if (mine.length === 0) return [];
    return [
      {
        component,
        desired: mine.reduce((sum, item) => sum + (item.spec?.replicas ?? 0), 0),
        ready: mine.reduce((sum, item) => sum + (item.status?.readyReplicas ?? 0), 0),
      },
    ];
  });
}
