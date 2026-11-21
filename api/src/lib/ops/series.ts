// Per-pod CPU and memory over the last 15 minutes (D31 follow-up): Prometheus query_range on the
// cAdvisor series the kubelet-cadvisor job scrapes (k8s/observability/prometheus/prometheus.yml).
const WINDOW_SECONDS = 900;
const STEP_SECONDS = 15;
const MILLI_PER_CORE = 1000;
const BYTES_PER_MIB = 1024 * 1024;
const MS_PER_SECOND = 1000;
const QUERY_TIMEOUT_MS = 1000;
const HTTP_OK_MAX = 299;

// The app's containers only: container!="" leaves out the pod-level cgroup row
const SELECT = 'namespace="contentcollab",container!="",pod!=""';
export const SERIES_QUERIES = {
  cpu: `sum by (pod) (rate(container_cpu_usage_seconds_total{${SELECT}}[1m]))`,
  memory: `sum by (pod) (container_memory_working_set_bytes{${SELECT}})`,
} as const;

export interface PodSeries {
  pod: string;
  points: { t: number; v: number }[];
}

export type Range = (
  promql: string,
  start: number,
  end: number,
  step: number,
) => Promise<PodSeries[]>;

type Fetch = (url: string) => Promise<Response>;

/** A query_range client for the Prometheus HTTP API; NaN samples are dropped. */
export function prometheusRange(
  baseUrl: string,
  fetchFn: Fetch = (url) => fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) }),
): Range {
  return async (promql, start, end, step) => {
    const url = `${baseUrl}/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${start}&end=${end}&step=${step}`;
    const response = await fetchFn(url);
    if (!response.ok || response.status > HTTP_OK_MAX) {
      throw new Error(`prometheus answered ${response.status}`);
    }
    const body = (await response.json()) as {
      status?: string;
      data?: { result?: { metric?: { pod?: string }; values?: [number, string][] }[] };
    };
    if (body.status !== "success") throw new Error("prometheus: the range query did not succeed");
    return (body.data?.result ?? []).map((row) => ({
      pod: row.metric?.pod ?? "unknown",
      points: (row.values ?? [])
        .map(([t, v]) => ({ t, v: Number(v) }))
        .filter((p) => Number.isFinite(p.v)),
    }));
  };
}

const scale = (series: PodSeries[], factor: number): PodSeries[] =>
  series.map((s) => ({ pod: s.pod, points: s.points.map((p) => ({ t: p.t, v: p.v * factor })) }));

/** CPU as millicores and memory as MiB per pod, for the 15 minutes before now, 15 s apart. */
export async function seriesFrom(range: Range, now: () => number = Date.now) {
  const end = Math.floor(now() / MS_PER_SECOND);
  const start = end - WINDOW_SECONDS;
  const [cpu, memory] = await Promise.all([
    range(SERIES_QUERIES.cpu, start, end, STEP_SECONDS),
    range(SERIES_QUERIES.memory, start, end, STEP_SECONDS),
  ]);
  return {
    windowSeconds: WINDOW_SECONDS,
    stepSeconds: STEP_SECONDS,
    cpu: scale(cpu, MILLI_PER_CORE),
    memory: scale(memory, 1 / BYTES_PER_MIB),
  };
}
