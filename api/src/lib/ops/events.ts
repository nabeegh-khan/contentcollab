// The events timeline (D31): Kubernetes events for the panel's reasons, newest first.
const SHOWN = new Set([
  "Scheduled",
  "Killing",
  "Started",
  "Unhealthy",
  "BackOff",
  "FailedScheduling",
  "SuccessfulCreate",
  "SuccessfulDelete",
  "ScalingReplicaSet",
  "SuccessfulRescale",
  "Evicted",
]);
const MAX_EVENTS = 30;
const MAX_NOTE = 200;

interface KubeEvent {
  regarding?: { kind?: string; name?: string };
  reason?: string;
  note?: string;
  type?: string;
  eventTime?: string | null;
  series?: { lastObservedTime?: string; count?: number };
  deprecatedLastTimestamp?: string | null;
  deprecatedCount?: number;
}

export interface TimelineEvent {
  at: string;
  type: string;
  reason: string;
  object: string;
  text: string;
  count?: number;
  /** Set on a drill row: what became of the eviction. */
  outcome?: string;
  source: "kubernetes" | "drill";
}

// An HPA's events carry eventTime: null and only deprecatedLastTimestamp (read on the cluster, 21 Nov 2026)
const timeOf = (e: KubeEvent) =>
  e.series?.lastObservedTime ?? e.eventTime ?? e.deprecatedLastTimestamp ?? null;

export function eventsFrom(list: unknown): TimelineEvent[] {
  const items = (list as { items?: KubeEvent[] } | null)?.items;
  if (!Array.isArray(items)) throw new Error("events: the reply was not an event list");
  const rows = items.flatMap((e): TimelineEvent[] => {
    const at = timeOf(e);
    if (!at || !e.reason || !SHOWN.has(e.reason)) return [];
    const count = e.series?.count ?? e.deprecatedCount;
    return [
      {
        at,
        type: e.type ?? "Normal",
        reason: e.reason,
        object: `${e.regarding?.kind ?? "?"}/${e.regarding?.name ?? "?"}`,
        text: (e.note ?? "").slice(0, MAX_NOTE),
        ...(count === undefined ? {} : { count }),
        source: "kubernetes",
      },
    ];
  });
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_EVENTS);
}
