# AI session log

Required by the ECE1779 project handout for the final deliverable: two to four AI interactions that meaningfully influenced the project, with what was asked, what came back, and what the team did with it (what was useful, what was wrong or incomplete, how it was verified or changed). Each of us appends our own entries under our name. Keep it to interactions that show judgment; routine wording help doesn't belong here.

Format per entry:

## Name

### Date, what it was about (issue number)

**Before asking:** our own understanding or plan first.

**Asked:** the question put to the AI.

**Got:** what came back.

**Did with it:** what was kept, what was wrong or missing, how it was checked.

## Nabeegh

### 21 October 2026, checking the architecture against current state (issues #16, #17)

**Before asking:** the 17 October architecture put ingress-nginx in front of the cluster and assumed the Socket.IO Redis adapter was all that real-time needed across API replicas. Before the 24 October meeting I wanted every component checked against its current documentation, because the course material and most tutorials predate 2026.

**Asked:** for each piece of `docs/ARCHITECTURE.md`, whether anything had been retired or changed, what several API pods mean for Socket.IO, and the monthly cost of the cluster on DigitalOcean.

**Got:** ingress-nginx was retired in March 2026 with no further security fixes and the Gateway API is the replacement; three options with trade-offs (Gateway API with a maintained controller, a DigitalOcean load balancer with its own certificate, keep ingress-nginx); for Socket.IO, the Redis adapter relays broadcasts between pods but does not route connections, so a session needs affinity unless clients use WebSocket only, and the proxy idle timeout has to exceed Socket.IO's 45 seconds; about $46 a month for two nodes, a load balancer and a volume.

**Did with it:** the retirement date and the recommended replacement match the Kubernetes blog post linked in `docs/RESEARCH.md`, so keeping ingress-nginx was ruled out: unpatched software is not defensible in a Q&A. The two remaining options went into `RESEARCH.md` and two decision issues for the 24 October meeting, which chose the Gateway API (#16). The cost figure was confirmed on the DigitalOcean pricing page before the e-transfer split was proposed.

### 21 to 31 October 2026, Socket.IO across API replicas (issue #17)

**Asked:** the simplest way to run Socket.IO behind a load balancer with two or more API pods.

**Got:** WebSocket-only transport on the client (`transports: ["websocket"]`), so round-robin balancing works and no session affinity is needed; sticky sessions as the alternative.

**Did with it:** the team did not take the simplest answer. On 24 October we chose sticky sessions with the Redis adapter, because WebSocket-only drops the HTTP long-polling fallback that keeps clients connected on networks that block WebSockets, and kept WebSocket-only as the fallback if the Gateway controller cannot pin sessions. What the answer left out was whether our controller supports affinity at all: the 31 October check of the NGINX Gateway Fabric documentation found cookie-based session persistence is NGINX Plus only and an experimental Gateway API field, with only `ip_hash` in the open-source build, which breaks for users behind one shared IP. So the decision is back on the 31 October agenda with that fact, and the proposal records the 24 October decision as made, not implemented.

### 31 October 2026, Kubernetes manifests and the deploy workflow (issues #32, PR #35)

**Before asking:** the object list came from `ARCHITECTURE.md` D1 and D10 and the practices table in `k8s/README.md`: Deployments with readiness and liveness probes, requests and limits, a non-root user and a termination grace period for SIGTERM; a StatefulSet with a volume claim for PostgreSQL; a HorizontalPodAutoscaler and a PodDisruptionBudget for the API; one ConfigMap mirroring `.env.example` and one Secret whose real values never enter the repo; a minikube overlay and a DOKS overlay; a workflow that builds and pushes the image on merge and rolls out only when a cluster exists.

**Asked:** to draft the Kustomize base and the two overlays from that list, matching the existing `compose.yaml` (same images, same health checks, same mount), plus the GitHub Actions deploy workflow and a CI job that validates the manifests.

**Got:** 16 files: the base objects, `secrets.example.yaml`, the overlays, `deploy.yml` with a build job and a rollout job that stops green while the `KUBECONFIG` secret is empty, and a `k8s` CI job that renders both overlays and runs kubeconform.

**Did with it:** rendered both overlays with `kubectl kustomize` and validated them with kubeconform against the Kubernetes 1.33 schemas and the Gateway API CRD schemas (10 and 12 objects, all valid); CI runs the same check on the PR. One correction: the draft set a `PGDATA` override on the postgres container; `compose.yaml` lets the `postgres:18` image choose its data directory under the mounted volume, so the override was removed to keep the two environments the same. The minikube run and the restart test from `k8s/README.md` are still to do, and the PR waits for a teammate's review before merge.
