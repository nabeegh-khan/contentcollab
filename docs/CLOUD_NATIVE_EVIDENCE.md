# Cloud-native evidence map

Design review, Wednesday 11 November 2026. Each core requirement, how ContentCollab meets it, the evidence we show, and where the work stands. Work counted for the presentation is what is complete by 24 November; our slot is Wednesday 2 December, 1:15pm.

Rule: the tooling serves the architecture, and nothing runs in the cluster that the two nodes cannot carry (ARCHITECTURE.md D18). DigitalOcean metrics and alert policies cover node CPU, memory and disk (the handout's required provider monitoring); application metrics are the Prometheus-format `/metrics` endpoint, the logs are JSON read with `kubectl logs`, and the error rate per route is read from them by `scripts/error-rate.mjs`. The Datadog agent is not installed: it does not fit (D6 and D17, superseded in part by D18).

| Requirement | How we meet it | Evidence shown | Status 11 Nov | Issue / PR |
|---|---|---|---|---|
| Containerization | Dockerfiles per service; `compose.yaml` for local; Kustomize base with `minikube` and `doks` overlays in `k8s/` | `docker compose up`, `kubectl kustomize k8s/doks`, images in DigitalOcean Container Registry | Built; web image pending | #86, #47 |
| Stateful persistence | PostgreSQL on a PersistentVolumeClaim (DigitalOcean Block Storage on DOKS); named volume in Compose; files in Spaces | `scripts/restart-test.sh`: write a row, delete the postgres pod, restart the API, scale postgres 0 to 1, read the row each time | In progress | #68 |
| Orchestration | Deployments with replicas, rolling updates (`maxUnavailable: 0`, readiness gate, preStop drain), HorizontalPodAutoscaler, PodDisruptionBudget | `kubectl get hpa -w` scaling 2 to N under load; `rollout restart` under load with zero non-2xx responses; `rollout undo` | In progress | #69, #82, #83 |
| CI/CD | Tests gate the image build; merge to `main` pins the image tag and rolls out; failed rollout is undone | Actions run from a merge to a new pod | Deploy waits on the cluster token | #70, #54, #94 |
| Monitoring | `/metrics` (prom-client): request count, latency histogram, errors; DigitalOcean Insights graphs and alert policies at 80% (`scripts/alerts.sh`) | Insights graphs; `/metrics` read through a port-forward; the alert policy list | `/metrics` built; Insights live; alert policies not yet created | #55, #62 |
| Observability (advanced) | Structured JSON request logs with request ID, method, route, status, duration, read with `kubectl logs`; the 5xx share per route from the log (`scripts/error-rate.mjs`) | Follow one request ID from the browser to its log line; the error-rate check going red when Redis is stopped | PR #102 (not rolled out) | #55, OBS-1 |

Gaps, in order of points at risk: JSON request logs and the error-rate monitor; the HPA and zero-drop rollout proof; the restart proof; the deploy token.


Advanced features for the 24 November cutoff (handout: at least two): auto-scaling and high availability (#69) and CI/CD (#70, #82). Both are finished and demonstrated by the cutoff, not presented as plans. Presentation slides are due 24 November, 11:59pm.

