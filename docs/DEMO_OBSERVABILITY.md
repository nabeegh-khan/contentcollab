# Demo: following a request through the logs, the dashboard and the alert

The monitoring part of the demo (step 8 of `docs/PRESENTATION.md`, issue #55). It shows three things in about a minute and a half: one request found in the logs by its ID, the per-route error rate on the dashboard, and the error-rate monitor firing. Design and reasons: `docs/ARCHITECTURE.md` D16 and D17.

**State on 11 November 2026.** The API writes the JSON request log and the new metric labels (branch `feature/55-json-logs`, pull request for #55). The Datadog agent is not installed on the cluster yet (#27), so the dashboard, the log search and the monitor have not been run against a live account; their files are validated against Datadog's published schemas and against what `/metrics` exports, and the checklist at the end lists what the first live run must confirm. Sections 1 and 4 work without Datadog and are the fallback if it is not ready.

## What the API writes

One JSON line per request on standard output. A request to an unknown route:

```
{"timestamp":"2026-11-11T16:35:40.137Z","level":"warn","msg":"request","http":{"request_id":"216de22f-7bbf-4693-8778-b4d2622eec45","method":"GET","route":"unmatched","status_code":404},"duration_ms":1.63}
```

- `http.request_id` is the `X-Request-Id` the client sent when it is 1 to 128 letters, digits, dots, underscores or hyphens, otherwise a new UUID. It is returned in the `X-Request-Id` response header.
- `http.route` is the matched template (`/documents/:documentId`), or `unmatched`; never the raw path. Headers, cookies, query strings and bodies are never logged.
- `level` is `error` for 5xx, `warn` for 4xx and `info` otherwise. A successful `/health` or `/metrics` request is `debug`, so the readiness probe (every 5 seconds on each pod) is not in the log unless `LOG_LEVEL=debug`.
- A failed request also writes a `request failed` line with `error.kind` (and, for a server error, `error.message` and `error.stack`); a request the client abandons writes `request aborted`.
- Metrics at `/metrics` (cluster-internal): `http_requests_total{method,route,status_class}`, `http_errors_total{method,route,status_class}` and `http_request_duration_seconds{method,route}`.

## 1. A request from the browser to its log line

1. Open `https://contentcollab.app/api/does-not-exist` in the browser, with the developer tools open on the Network tab. The Gateway routes `/api` to the API, which answers 404 and logs it at `warn`.
2. Click the request and read the `X-Request-Id` response header. Or choose the ID yourself: `curl.exe -i -H "X-Request-Id: demo-001" https://contentcollab.app/api/does-not-exist`.
3. Find it in the pod logs: `kubectl -n contentcollab logs -l app=api --prefix --tail=200 | grep demo-001` (Git Bash; the `--prefix` shows which pod answered). One `request` line appears with the same `request_id`.
4. In Datadog, Logs, search `kube_namespace:contentcollab @http.request_id:demo-001`. The same line shows with its attributes as columns.

A request that fails inside a handler writes two lines with the same ID: `request failed` (with `error.kind`, `error.message`, `error.stack`) and `request`.

## 2. The dashboard

Import `k8s/doks/datadog/dashboard.json`: Dashboards, New Dashboard, name it, then Configure, Import dashboard JSON, and paste the file (the import replaces the dashboard's content). Widgets: requests per second by route; 5xx share by route with the 2% line; 5xx responses in the last five minutes; average latency by route; 5xx by route over the last hour; the request log; and a note on following a request by its ID.

Generate some traffic first, so the lines are not empty: `BASE=https://contentcollab.app STEPS=20 STEP_SECONDS=60 SKIP_HPA_CHECK=1 node scripts/loadtest.mjs` (the load test hits `/health`; for a route with errors see section 3).

Limit: latency is an average (`.sum` divided by `.count`). A p95 needs the histogram buckets submitted as distributions, which is a change to the check's annotation in `k8s/base/api.yaml`, not part of this change.

## 3. The monitor firing

The file `k8s/doks/datadog/monitor-error-rate.json` alerts when more than 2% of the requests to a route answered 5xx over five minutes, with a warning at 1%, one alert per route. Create it from Monitors, New Monitor, Import from JSON (check the exact menu label on the day), or with the Datadog API using keys typed by the operator, never stored in the repository:

```
curl -X POST "https://api.<site>/api/v1/monitor" -H "Content-Type: application/json" -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" -d @k8s/doks/datadog/monitor-error-rate.json
```

To make it fire without adding a failing route, stop Redis. `/health` then answers 503 on both pods, the kubelet probes it every 5 seconds, and every probe is counted as a 5xx on the route `/health`, so the share passes 2% within seconds of the metrics reaching Datadog (allow two to three minutes for the metric delay and the monitor's one-minute evaluation):

```
kubectl -n contentcollab scale deploy/redis --replicas=0     # monitor goes to warning, then alert
kubectl -n contentcollab scale deploy/redis --replicas=1     # recovery
```

What the audience sees while it is down: both pods are unready, so the Gateway has no pod to send requests to and the site stops answering; `kubectl -n contentcollab logs -l app=api --prefix` shows `level":"error"` request lines for `/health`, and the dashboard's 5xx widgets rise. Redis holds no persistent data (`k8s/base/redis.yaml`), so nothing is lost, but the site is down for as long as it is scaled to zero: rehearse the timing, and do it once, at the end of step 8.

The alternative is to stop PostgreSQL (`kubectl -n contentcollab scale statefulset/postgres --replicas=0`), which does not delete the volume but takes longer to recover; use Redis.

## 4. Without Datadog (local stack, or if the agent is not ready)

```
docker compose up --build -d
curl -i -H "X-Request-Id: demo-001" http://localhost:3000/does-not-exist     # 404, header echoed
docker compose logs api | grep demo-001                                      # the JSON line
curl -s http://localhost:3000/metrics | grep -E "^http_(requests|errors)_total"
docker compose stop redis
curl -i http://localhost:3000/health                                         # 503, and an "error" line in the log
docker compose start redis
```

The metrics lines look like this (labels are bounded: the route is a template or `unmatched`, the status is a class):

```
http_requests_total{method="GET",route="/health",status_class="5xx"} 1
http_requests_total{method="GET",route="unmatched",status_class="4xx"} 1
http_errors_total{method="GET",route="/health",status_class="5xx"} 1
```

On the cluster the same view is `kubectl -n contentcollab port-forward deploy/api 3000:3000` and then the `curl` against `localhost:3000/metrics`; the Gateway never routes `/metrics`.

## Not yet verified (first live run, after the agent is installed)

- `Metrics Summary` shows `contentcollab.http_requests.count`, `contentcollab.http_errors.count` and `contentcollab.http_request_duration_seconds.sum` and `.count`, with the tags `method`, `route` and `status_class` (the names follow Datadog's OpenMetrics rules, checked in D16).
- The log search above finds the line by `@http.request_id`, and `@http.route`, `@http.status_code` and `@duration_ms` are columns.
- The monitor imports without changes, is grouped by `route`, and its message shows the route name.
- If `duration_ms` should drive Datadog's duration display, add a remapper in the log pipeline from `duration_ms` to `duration` (Datadog's `duration` is in nanoseconds, so multiply by 1,000,000 with an arithmetic processor); this is configured in Datadog, not in the repository.
- Startup lines (`api listening on 3000`) are still plain text; Datadog keeps them as unparsed messages.
