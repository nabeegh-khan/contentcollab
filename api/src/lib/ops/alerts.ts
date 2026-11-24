// The alert table (D35): the three DigitalOcean policies of scripts/alerts.sh, next to what Prometheus reads now.
// Prometheus reads the kubelet's usage of each node, not the droplet, so the figures are close to DigitalOcean's,
// not equal; the status is ours, DigitalOcean only sends the email. A test keeps the numbers equal to the script.
import type { Query } from "./traffic.js";

export const ALERT_THRESHOLD_PERCENT = 80;
export const ALERT_WINDOW_MINUTES = 5;
const PERCENT = 100;

// The busiest node: any one droplet over its limit is enough for DigitalOcean to send the email
export const ALERT_QUERIES = {
  cpu: `${PERCENT} * max(rate(node_cpu_usage_seconds_total[2m]) / on(node) kube_node_status_allocatable{resource="cpu"})`,
  memory: `${PERCENT} * max(node_memory_working_set_bytes / on(node) kube_node_status_allocatable{resource="memory"})`,
} as const;

export interface AlertRow {
  metric: "CPU" | "Memory" | "Disk";
  thresholdPercent: number;
  valuePercent: number | null;
}

export interface AlertsCard {
  thresholdPercent: number;
  windowMinutes: number;
  rows: AlertRow[];
}

/** Disk has no node-disk series in Prometheus here, so its value is null (not measured), never a guess. */
export async function alertsFrom(query: Query): Promise<AlertsCard> {
  const [cpu, memory] = await Promise.all([query(ALERT_QUERIES.cpu), query(ALERT_QUERIES.memory)]);
  const row = (metric: AlertRow["metric"], valuePercent: number | null): AlertRow => ({
    metric,
    thresholdPercent: ALERT_THRESHOLD_PERCENT,
    valuePercent,
  });
  return {
    thresholdPercent: ALERT_THRESHOLD_PERCENT,
    windowMinutes: ALERT_WINDOW_MINUTES,
    rows: [row("CPU", cpu), row("Memory", memory), row("Disk", null)],
  };
}
