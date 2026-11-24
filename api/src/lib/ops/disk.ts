// How full the database disk is (D35), from the kubelet's volume statistics. Prometheus does not scrape
// them on this cluster (checked 24 Nov 2026), so the answer is usually null, which the page shows as
// "not measured". A missing series is never turned into a number.
import type { Query } from "./traffic.js";

const PERCENT = 100;
const SELECT = 'namespace="contentcollab",persistentvolumeclaim="data-postgres-0"';

export const DISK_QUERY = `${PERCENT} * max(kubelet_volume_stats_used_bytes{${SELECT}} / kubelet_volume_stats_capacity_bytes{${SELECT}})`;

export const diskUsedFrom = (query: Query): Promise<number | null> => query(DISK_QUERY);
