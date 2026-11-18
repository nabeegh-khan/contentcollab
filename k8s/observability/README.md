# k8s/observability

The observability stack of ARCHITECTURE D19, in its own namespace so it can be installed for a demo and removed afterwards. Part a (#109): Prometheus, kube-state-metrics and Grafana. Loki with Fluent Bit (part b) and the OpenTelemetry Collector with Jaeger (part c) are added here later.

```
bash scripts/observability-up.sh       # checks the context and two Ready nodes, then applies this directory
bash scripts/observability-down.sh     # removes it all
kubectl -n observability port-forward svc/grafana 3001:3000      # http://localhost:3001, user admin
kubectl -n observability port-forward svc/prometheus 9090:9090   # http://localhost:9090/targets
```

| File | What it holds |
|---|---|
| `prometheus/prometheus.yml` | Scrape jobs: `api` (EndpointSlices of the api Service), `kubelet-resource` and `kubelet-cadvisor` (HTTPS, cluster CA, kept to the metrics the dashboard reads), `kube-state-metrics`. Checked by `promtool check config` in CI |
| `prometheus/prometheus.yaml` | Deployment (24 h, 1 GB, emptyDir), Service, read-only ClusterRole (no `nodes/proxy`, no Secrets) |
| `kube-state-metrics.yaml` | Only HPAs (namespace `contentcollab`) and nodes |
| `prometheus/dashboard.test.yml` | `promtool test rules` cases for every dashboard query, on series labelled as `prometheus.yml` labels them; run in CI |
| `grafana/` | Deployment (256 MiB requested, 512 MiB limit: it was OOMKilled at 192 MiB; plugin downloads off; a startup probe allowing five minutes), provisioned data source (uid `prometheus`), dashboard provider, `dashboards/contentcollab.json` |
| `observability.test.mjs` | The rendered objects and the dashboard against D19: `node --test k8s/observability/*.test.mjs` (needs kubectl and yq 4) |

Nothing here is routed by the Gateway. The dashboard's panels: request rate per route (without `/metrics` and `/health`), 5xx share per route with the 2% line (0 before a route's first error), p95 latency per route, the HPA's current, desired and maximum replicas, and node memory in use against allocatable.
