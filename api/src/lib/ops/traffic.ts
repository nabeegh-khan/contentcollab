// The traffic card (D31): request rate, p50, p95 and error percent of the last minute, from Prometheus.
const WINDOW_SECONDS = 60;
const PERCENT = 100;
const HTTP_OK_MAX = 299;
const QUERY_TIMEOUT_MS = 1000;

// Everything the API serves except the scrape and the panel's own polling; /health stays in (D31)
const S = 'job="api",route!~"/metrics|/api/v1/ops(/.*)?"';
const RATE = `sum(rate(http_requests_total{${S}}[1m]))`;
const bucket = `sum by (le) (rate(http_request_duration_seconds_bucket{${S}}[1m]))`;

export const TRAFFIC_QUERIES = {
  rate: RATE,
  p50: `histogram_quantile(0.5, ${bucket})`,
  p95: `histogram_quantile(0.95, ${bucket})`,
  errorPercent: `${PERCENT} * (sum(rate(http_requests_total{${S},status_class="5xx"}[1m])) or vector(0)) / ${RATE}`,
} as const;

/** Runs one PromQL expression; resolves to a number, or null for an empty vector or NaN. */
export type Query = (promql: string) => Promise<number | null>;

type Fetch = (url: string) => Promise<Response>;

/** An instant-query client for the Prometheus HTTP API (`/api/v1/query`). */
export function prometheusQuery(
  baseUrl: string,
  fetchFn: Fetch = (url) => fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) }),
): Query {
  return async (promql) => {
    const response = await fetchFn(`${baseUrl}/api/v1/query?query=${encodeURIComponent(promql)}`);
    if (!response.ok || response.status > HTTP_OK_MAX) {
      throw new Error(`prometheus answered ${response.status}`);
    }
    const body = (await response.json()) as {
      status?: string;
      data?: { result?: { value?: [number, string] }[] };
    };
    if (body.status !== "success") throw new Error("prometheus: the query did not succeed");
    const raw = body.data?.result?.[0]?.value?.[1];
    const value = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  };
}

export interface TrafficCard {
  windowSeconds: number;
  requestsPerSecond: number | null;
  p50Seconds: number | null;
  p95Seconds: number | null;
  errorPercent: number | null;
  noTraffic: boolean;
}

export async function trafficFrom(query: Query): Promise<TrafficCard> {
  const [rate, p50, p95, errors] = await Promise.all([
    query(TRAFFIC_QUERIES.rate),
    query(TRAFFIC_QUERIES.p50),
    query(TRAFFIC_QUERIES.p95),
    query(TRAFFIC_QUERIES.errorPercent),
  ]);
  const noTraffic = rate === null || rate === 0;
  return {
    windowSeconds: WINDOW_SECONDS,
    requestsPerSecond: rate,
    p50Seconds: noTraffic ? null : p50,
    p95Seconds: noTraffic ? null : p95,
    errorPercent: noTraffic ? null : errors,
    noTraffic,
  };
}
