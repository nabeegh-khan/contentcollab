# Cluster audit against docs/PRACTICES.md

Read on 11 November 2026 from what `kubectl kustomize k8s/minikube` and `kubectl kustomize k8s/doks` render on `main` (7d3e60b), the scripts in `scripts/`, and `.gitignore`. Where a row says "fixed in PR #97", the fix and the check script exist only on that branch until it merges; on `main` today INF-10 and the Redis part of SEC-6 are still gaps. Nothing here was run on a live cluster: "met" means the rendered manifest or script says so, not that a pod was observed. Status: **met**, **gap** (fixed or open, see the last column) or **n/a** (with the reason).

Once PR #97 (issue #96) merges, the rows INF-8 to INF-11, OBS-5 and SEC-6 are checked on every pull request by `scripts/check-manifests.sh` (CI job `k8s`, step "Lecture 8 rows on the rendered overlays"); its test runs the check on `scripts/testdata/manifests-bad.yaml` and requires a message for every sub-check. A fresh reviewer mutated the check (24 single changes: 5 missed, plus vacuous passes on empty input and swallowed yq errors); all of those are closed in the PR and the missed changes now fail it.

| Row | File | Status | Evidence |
|---|---|---|---|
| INF-1 | docs/ARCHITECTURE.md | met | Managed Kubernetes on DigitalOcean; decision recorded there |
| INF-2 | k8s/base/configmap.yaml, api.yaml, worker.yaml | met, one nit | Ports, hosts and bucket come from the ConfigMap and the Secret through `envFrom`; the same Dockerfile builds the image used in Compose, minikube and DOKS. Nit: the Postgres probes hard-code `pg_isready -U user -d contentcollab` (it only asks whether the server accepts connections, so a different real user does not fail it) |
| INF-3 | scripts/cluster-up.sh, cluster-down.sh, alerts.sh, metrics-server.sh | **partly met** | `cluster-up.sh` and `alerts.sh` stop on a missing variable; no dashboard clicks in the bring-up. `cluster-down.sh` has no tool check (a missing `doctl` fails after the confirmation prompt), `metrics-server.sh` has no variable check, and `cluster-up.sh` on `main` has no `doctl` sign-in check, which the PRACTICES.md wording says it has. PR #94 rewrites `cluster-up.sh`, so that part waits for it |
| INF-4 | k8s/base/api.yaml | met | `replicas: 2`, Service in front, readiness on `/health`, HPA 2 to 5, PodDisruptionBudget `minAvailable: 1`, topology spread over nodes |
| INF-5 | k8s/base/api.yaml, worker.yaml; .github/workflows/deploy.yml | met | `RollingUpdate`, `maxUnavailable: 0`, `maxSurge: 1` on the API; CI sets the commit SHA with `kustomize edit set image` and undoes a failed rollout. The rendered overlay still shows `:latest` (see INF-9) |
| INF-6 | scripts/cluster-up.sh | met | `REGION` defaults to `tor1` (Toronto); API minimum is 2 replicas, so no cold start |
| INF-7 | scripts/cluster-down.sh | met | Deletes the cluster, load balancer and volumes after typing the cluster name. Open: the final deletion after grading is a calendar item, not a file |
| INF-8 | k8s/base/api.yaml, worker.yaml, redis.yaml, postgres.yaml | met | Every `selector.matchLabels` entry is a pod template label; every Service selects an `app` label that a workload carries (checked by `check-manifests.sh`, both overlays) |
| INF-9 | k8s/base/api.yaml, worker.yaml; deploy.yml; cluster-up.sh | met, with one residual | Postgres and Redis use `postgres:18` and `redis:8` (a major version, minor floats). Our images carry `:latest` in the base only as a placeholder: deploy.yml pins both to the commit SHA and cluster-up.sh rewrites them before applying. A hand-run `kubectl apply -k k8s/doks` would deploy `:latest`; the check allows `:latest` only on `ghcr.io/nabeegh-khan/contentcollab-*` for that reason. Not changed: cluster-up.sh matches the `:latest` text and belongs to PR #94 |
| INF-10 | k8s/base/api.yaml, postgres.yaml, redis.yaml | **gap, fixed in PR #97 (open)** | Before: the API, Postgres and Redis container ports had no name, the Services used `targetPort: 3000/5432/6379` and the API probes used `3000` (8 INF-10 lines and 1 SEC-6 line in CI run 43053892260). After: `http`, `postgres`, `redis`; Services and probes refer to the names. The worker already did. The Datadog annotation URL keeps the number because it is a string |
| INF-11 | k8s/base/api.yaml, worker.yaml | met | Readiness `httpGet /health`; liveness `tcpSocket` on the API and worker, `exec` on Postgres and Redis. No liveness probe calls `/health` |
| SEC-1 | .gitignore, k8s/base/ | met | `.env`, `.env.*`, `k8s/**/secret*.yaml` ignored except `*.example.yaml`; only `secrets.example.yaml` is tracked |
| SEC-2 | k8s/base/api.yaml, worker.yaml, postgres.yaml | **gap, open** | The Secret reaches the API and worker as environment variables through `envFrom`, Postgres through `secretKeyRef`; nothing is file-mounted, so the "mounted" wording in PRACTICES.md is not what the manifests do. The apps read `process.env`; mounting needs a `_FILE` read in the API and worker code. It is a stated trade-off, not fixed here |
| SEC-6 | k8s/base/api.yaml, worker.yaml, redis.yaml, postgres.yaml | **gap, partly fixed in PR #97 (open)** | API and worker set `runAsNonRoot` with uid 1000. Redis did not: now uid/gid 999 (the image's `redis` user; `docker run --user 999:999 redis:8` answers `PONG`). Postgres still starts as root to prepare the volume; running it as uid 999 needs `fsGroup` on DigitalOcean block storage and a live check, so it is exempt in the check (`ROOT_EXEMPT=postgres`) and open |
| SEC-8 | k8s/base/postgres.yaml, redis.yaml, api.yaml | met | Postgres is headless (`clusterIP: None`), Redis and the API are `ClusterIP`; only the Gateway (`k8s/doks/gateway.yaml`) is exposed. The minikube overlay makes the API a `NodePort` for the laptop only. There are no NetworkPolicies, so any pod in the cluster can reach Postgres; the row asks for no public port, not for pod isolation |
| SEC-10 | .gitignore, scripts/cluster-up.sh | met | No real Secret in the tree; `cluster-up.sh` applies a git-ignored copy of `secrets.example.yaml` filled in by hand; CI gets a short-lived kubeconfig (ARCHITECTURE D13) |
| OBS-1 | api/src/middleware/logger.ts | **gap, open** | One text line per request with time, method, path, status and duration. PRACTICES.md says "structured JSON logs"; they are not. Needs a code change and a test in the API, so a separate issue |
| OBS-2 | n/a | n/a | A habit, not a file |
| OBS-3 | scripts/alerts.sh | met on `main`, not run live | Three policies per cluster at 80% for five minutes; exercised with a stub `doctl` by a fresh reviewer on 11 November, never against the account |
| OBS-4 | api/src/routes/metrics.ts; k8s/base/api.yaml | met | `/metrics` served; Datadog autodiscovery annotation on the API pods |
| OBS-5 | all four workloads | met | Requests and limits for CPU and memory on every container (checked by `check-manifests.sh`) |

## Per-workload summary

| Workload | Selector | Image tag | Named port | Probes | Requests and limits | securityContext | PDB | HPA |
|---|---|---|---|---|---|---|---|---|
| api | app=api, matches | placeholder `:latest`, pinned by CI | `http` | readiness `/health`, liveness socket | 100m/128Mi, 500m/256Mi | runAsNonRoot, uid 1000 | `minAvailable: 1` | 2 to 5 at 70% CPU |
| worker | app=worker, matches | placeholder `:latest`, pinned by CI | `http` | readiness `/health`, liveness socket | 100m/128Mi, 500m/512Mi | runAsNonRoot, uid 1000 | n/a: one replica, a budget would block node drains | n/a: queue consumer, `WORKER_CONCURRENCY` |
| redis | app=redis, matches | `redis:8` | `redis` | exec `redis-cli ping` | 50m/64Mi, 200m/128Mi | runAsNonRoot, uid 999 (#97) | n/a: one replica | n/a |
| postgres | app=postgres, matches | `postgres:18` | `postgres` | exec `pg_isready` | 100m/256Mi, 500m/512Mi | none (open) | n/a: one replica | n/a |

Overlap with open pull requests, so not touched here: PR #94 (`scripts/cluster-up.sh`, `scripts/cluster-up.test.mjs`, `scripts/lib/cluster-up-lib.sh`, `scripts/testdata/cluster-up-stub.sh`, `scripts/README.md`) and PR #88 (`k8s/doks/migrate-job.yaml`, `k8s/doks/infra/`, `.github/workflows/deploy.yml`, `compose.yaml`). The check ignores Jobs, so #88's migration Job does not trip it.

## Commands for the 2 December demo

Run against the DOKS cluster; `-n contentcollab` is the namespace. The named-port fix was also applied to a throwaway k3s cluster in Docker by a fresh reviewer (stand-in API image): Services got endpoints through the names, probes by name passed, Redis ran as uid 999 and answered PING; the real API image and DOKS block storage were not tried. Flags read from `kubectl` v1.36.1 `--help` on 11 November. **Not yet run on the cluster**: rehearse each once and note the output.

Replicas and self-healing:

```
kubectl -n contentcollab get deploy,hpa,pdb
kubectl -n contentcollab get pods -l app=api -o wide        # two pods, two nodes
kubectl -n contentcollab delete pod <one-api-pod-name>      # the ReplicaSet replaces it
kubectl -n contentcollab get pods -l app=api -w
```

Scaling (metrics-server first, once: `bash scripts/metrics-server.sh`; `scripts/hpa-ready.mjs` says when CPU is readable):

```
BASE=https://contentcollab.app node scripts/loadtest.mjs    # 10 to 200 req/s, 60 s a step
kubectl -n contentcollab get hpa api -w                     # in a second terminal: 2 -> 5
kubectl -n contentcollab top pods
```

Rollout and undo (the old pods keep serving because `maxUnavailable: 0`):

```
kubectl -n contentcollab rollout history deploy/api
kubectl -n contentcollab set image deploy/api api=ghcr.io/nabeegh-khan/contentcollab-api:does-not-exist
kubectl -n contentcollab rollout status deploy/api --timeout=30s     # times out, new pod ErrImagePull
kubectl -n contentcollab get pods -l app=api                         # two old pods still Ready
kubectl -n contentcollab rollout undo deploy/api
kubectl -n contentcollab rollout status deploy/api
```

A rolling restart under load with no failed requests: `BASE=https://contentcollab.app ROLLOUT=1 SKIP_HPA_CHECK=1 STEPS=50 STEP_SECONDS=120 node scripts/loadtest.mjs` (#69; the final measurement is still to be recorded, `docs/loadtest/`).
