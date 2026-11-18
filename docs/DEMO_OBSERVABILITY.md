# Demo: following a request through the logs, the provider dashboard and the error-rate check

The monitoring part of the demo (step 8 of `docs/PRESENTATION.md`, issue #55). It shows four things in about a minute and a half: one request found in the logs by its ID, the provider's dashboard and alert policies, the application's metrics, and the error-rate check turning red when a dependency is stopped. Design and reasons: `docs/ARCHITECTURE.md` D16 (logs and metric labels), D17 and D18 (why no agent runs in the cluster).

**State on 11 November 2026.** The JSON request log, the metric labels and `scripts/error-rate.mjs` are in pull request #102 and are not on the cluster: the running image is the 4 November build, which writes plain-text logs, so steps 1 and 4 need #102 merged and rolled out first. The DigitalOcean Insights tab and `/metrics` work today; the alert policies are created by `scripts/alerts.sh`, which has not been run on the cluster (`doctl monitoring alert list` is empty). Nothing here needs an account other than DigitalOcean's. The checklist at the end lists what the first run on the rebuilt cluster must confirm.

## What the API writes

One JSON line per request on standard output. A request to an unknown route:

```
{"timestamp":"2026-11-11T16:35:40.137Z","level":"warn","msg":"request","http":{"request_id":"216de22f-7bbf-4693-8778-b4d2622eec45","method":"GET","route":"unmatched","status_code":404},"duration_ms":1.63}
```

- `http.request_id` is the `X-Request-Id` the client sent when it is 1 to 128 letters, digits, dots, underscores or hyphens, otherwise a new UUID. It is returned in the `X-Request-Id` response header.
- `http.route` is the matched template (`/documents/:documentId`), or `unmatched`; never the raw path. Headers, cookies, query strings and bodies are never logged.
- `level` is `error` for 5xx, `warn` for 4xx and `info` otherwise. A successful `/health` or `/metrics` request is `debug`, so the readiness probe (every 5 seconds on each pod) is not in the log unless `LOG_LEVEL=debug`; a failing probe is an `error` line.
- A failed request also writes a `request failed` line with `error.kind` (and, for a server error, `error.message` and `error.stack`); a request the client abandons writes `request aborted`.
- Metrics at `/metrics` (cluster-internal): `http_requests_total{method,route,status_class}`, `http_errors_total{method,route,status_class}` and `http_request_duration_seconds{method,route}`.

## 1. A request from the browser to its log line

1. Open `https://contentcollab.app/api/does-not-exist` in the browser, with the developer tools open on the Network tab. The Gateway routes `/api` to the API, which answers 404 and logs it at `warn`.
2. Click the request and read the `X-Request-Id` response header. Or choose the ID yourself: `curl.exe -i -H "X-Request-Id: demo-001" https://contentcollab.app/api/does-not-exist`.
3. Find it in the pod logs (Git Bash): `kubectl -n contentcollab logs -l app=api --prefix --tail=200 | grep demo-001`. The `--prefix` shows which pod answered. One `request` line appears with the same `request_id`.

## 2. The provider's dashboard and alert policies

- **Dashboard.** DigitalOcean control panel, Kubernetes, the `contentcollab` cluster, Insights tab: CPU usage, load average, memory, disk and disk I/O for the cluster, the node pool and each node. Every DOKS cluster runs DigitalOcean's metrics agent, so there is nothing to install (docs.digitalocean.com/products/kubernetes/how-to/monitor-basic, read 11 November 2026). Its memory graph leaves out reclaimable memory, so it reads lower than `kubectl top nodes`.
- **Alert policies.** `doctl monitoring alert list` shows CPU, memory and disk above 80% for five minutes, assigned to the cluster's tag and emailed. They are created by `ALERT_EMAIL=<a verified address> bash scripts/alerts.sh` (#62) and have to be created again after every rebuild, because the tag carries the cluster ID. The CPU, memory and disk graphs are what the policies watch.

## 3. The application's metrics

```
kubectl -n contentcollab port-forward deploy/api 3000:3000          # leave running in a second terminal
curl -s http://localhost:3000/metrics | grep -E "^http_(requests|errors)_total"
```

The Gateway never routes `/metrics`, so this is the only way in. The lines look like this (labels are bounded: the route is a template or `unmatched`, the status is a class):

```
http_requests_total{method="GET",route="/health",status_class="5xx"} 1
http_requests_total{method="GET",route="unmatched",status_class="4xx"} 1
http_errors_total{method="GET",route="/health",status_class="5xx"} 1
```

## 4. The error-rate check turning red

`scripts/error-rate.mjs` reads the request log and prints the 5xx share per route (`--tail=-1` in the commands matters: with a selector, `kubectl logs` returns only the last 10 lines of each pod unless told otherwise, and the share would come from that sample); it exits 1 when a route with at least 10 requests is above 2% (the threshold in the failure table of `docs/ARCHITECTURE.md`; `THRESHOLD` and `MIN_REQUESTS` change it), or on any failing `/health` or `/metrics`.

```
# healthy: send some traffic that is logged (a successful /health is not), then every route is "ok"
for i in $(seq 1 15); do curl -s -o /dev/null https://contentcollab.app/api/does-not-exist; done
kubectl -n contentcollab logs -l app=api --since=2m --tail=-1 --prefix | node scripts/error-rate.mjs

# stop Redis: /health answers 503 on both pods, and the kubelet probes it every 5 seconds
kubectl -n contentcollab scale deploy/redis --replicas=0
sleep 60
kubectl -n contentcollab logs -l app=api --since=2m --tail=-1 --prefix | node scripts/error-rate.mjs     # /health  ALERT, exit 1

kubectl -n contentcollab scale deploy/redis --replicas=1                                       # recovery
```

What the audience sees: both pods become unready, so the Gateway has no pod to send requests to and the site stops answering; the `/health` row goes to 100% and ALERT (a successful probe is not logged, so the log holds failures only for that route and any failing probe is an alert). Redis holds no persistent data (`k8s/base/redis.yaml`), so nothing is lost, but the site is down while it is scaled to zero: rehearse the timing, do it once, at the end of step 8, and scale it back at once. The check reads the pods' own logs, so it sees only what the pods still hold; a pod's log is gone with the pod. After Redis is back, the failing `/health` lines leave the two-minute window and the check reports no request lines (exit 2) until other traffic arrives: that is "no data", not "all clear", by design.

## 5. Without the cluster (the Compose stack on the presenting laptop)

```
docker compose up --build -d
curl -i -H "X-Request-Id: demo-001" http://localhost:3000/does-not-exist     # 404, header echoed
docker compose logs api | grep demo-001                                      # the JSON line
curl -s http://localhost:3000/metrics | grep -E "^http_(requests|errors)_total"
docker compose stop redis
for i in $(seq 1 15); do curl -s -o /dev/null http://localhost:3000/health; done
docker compose logs api | node scripts/error-rate.mjs                        # /health ALERT, exit 1
docker compose start redis
```

## Not installed, and why

No monitoring agent runs in the cluster. On the two 2 GB nodes measured before the rebuild, by placement it failed: an agent of 256 MiB on each node left 234.6 and 42.6 MiB, so the 256 MiB cluster agent fit on neither node (`AGENT_MI=256 CLUSTER_AGENT_MI=256 node scripts/memory-headroom.mjs`). With the API at its five-pod maximum, 405 MiB of memory was unrequested and about 172 MiB unused across the two nodes (11 November 2026, `node scripts/memory-headroom.mjs`); a Datadog agent requests 768 MiB, and a Prometheus and Grafana pair needed more than the real memory left (D18). The rebuilt cluster has larger nodes (D13), so these numbers no longer describe it: re-measuring it is open, and D18 is revisited if an agent then fits. The Datadog dashboard and monitor files (`k8s/doks/datadog/`) stay in the repository (checked once against Datadog's published Dashboard and Monitor schemas, not against an account), for use only if a third node is ever added.

## To confirm on the rebuilt cluster

- `node scripts/memory-headroom.mjs` on the rebuilt cluster (s-2vcpu-4gb nodes, autoscaling 1 to 2, D13): the numbers in D18 are from the old 2 GB nodes and do not carry over.
- The Insights tab shows both worker nodes; `bash scripts/alerts.sh` creates three policies and `doctl monitoring alert list` shows them.
- After #102 is rolled out: section 1 finds the request by its ID; section 4 goes from ok to ALERT within a minute of stopping Redis, and two minutes after starting it again the failing lines have left the window.
- After a scale-up or a rollout, a readiness probe can reach a new pod before it has connected to Redis and get a 503: the check then shows a `/health` failure or two without an outage. Read the count and the pods' ages before calling it red.
- The Redis stop in section 4 is checked against the code (`/health` returns 503 when Redis is down, readiness is `/health`, liveness is the socket) and has not been run on the cluster yet.
