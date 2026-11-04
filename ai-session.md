# AI session log

Required by the ECE1779 project handout for the final deliverable: two to four AI interactions that meaningfully influenced the project. For each: the prompt, the response (trimmed or summarized if long), and one to three bullets on what the team did with it (what was useful, what was incorrect or incomplete, how it was verified, modified or replaced). Each of us appends our own entries under our name. Keep it to interactions that show judgment; routine wording help does not belong here.

Format per entry, from the handout:

```
## Session title (issue number)

### Prompt

### AI Response

### What Your Team Did With It
- ...
```

## Nabeegh

## Checking the 17 October architecture against current state (#16, #17), 21 October 2026

### Prompt

For each component in `docs/ARCHITECTURE.md` (DigitalOcean Kubernetes, ingress-nginx with cert-manager, Socket.IO with the Redis adapter across several API pods, PostgreSQL on a DigitalOcean Volume, Spaces), check the current documentation for anything retired or changed since the course material was written, say what several API replicas mean for Socket.IO, and estimate the monthly cost of the cluster on DigitalOcean.

### AI Response

ingress-nginx was retired in March 2026 with no further releases or security fixes; the Gateway API is the recommended replacement. Three options with trade-offs: the Gateway API with a maintained controller (supported path, new objects to learn), a DigitalOcean load balancer with its own certificate (fewest moving parts, path routing needs a second load balancer or a proxy), or keep ingress-nginx (most tutorials, unpatched). For Socket.IO, the Redis adapter relays broadcasts between pods but does not route connections, so a session needs affinity unless clients use WebSocket only, and the proxy idle timeout must exceed Socket.IO's 45 seconds. Cost about $46 a month for two nodes, a load balancer and a volume, control plane free.

### What Your Team Did With It

- Useful: the retirement was not known to any of us and it removed the ingress we had planned. The retirement date and the recommended replacement match the Kubernetes blog post linked in `docs/RESEARCH.md`, and the cost matches the DigitalOcean pricing page, checked before the cost split was proposed.
- Decision: keeping ingress-nginx was ruled out because unpatched software is not defensible in a Q&A; the two remaining options went into `RESEARCH.md` and two decision issues, and the 24 October meeting chose the Gateway API (#16).

## Socket.IO across API replicas (#17), 21 to 31 October 2026

### Prompt

What is the simplest way to run Socket.IO behind a load balancer with two or more API pods, given the Redis adapter is already in the design?

### AI Response

WebSocket-only transport on the client (`transports: ["websocket"]`), so round-robin balancing works and no session affinity is needed; sticky sessions are the alternative if the long-polling transport has to stay.

### What Your Team Did With It

- Not taken as given: on 24 October the team chose sticky sessions with the Redis adapter, because WebSocket-only drops the HTTP long-polling fallback that keeps clients connected on networks that block WebSockets, and kept WebSocket-only as the fallback if the Gateway controller cannot pin sessions.
- Incomplete: the answer did not consider whether our controller supports affinity at all. The 31 October check of the NGINX Gateway Fabric documentation found cookie-based session persistence is NGINX Plus only and an experimental Gateway API field, with only `ip_hash` in the open-source build, which breaks for users behind one shared IP. The decision went back to the 31 October meeting with that fact; the proposal records the 24 October decision as made, not implemented.

## Laying out the Kubernetes manifests (#32, PR #35), 31 October 2026

### Prompt

The course has covered Kubernetes in one lecture: Deployments, Services, persistent volume claims and the HorizontalPodAutoscaler. Our `compose.yaml` runs api, PostgreSQL and Redis locally with health checks and a named volume. How should the manifests be organised so minikube and DigitalOcean share one source without copying files, which probe and resource settings does each object need, and how do secrets stay out of the repository?

### AI Response

One Kustomize base with a `minikube` and a `doks` overlay: the overlays patch only what differs (replica count, image source, storage class, the Gateway). Each container gets a readiness probe, a liveness probe, CPU and memory requests and limits, a non-root user and a termination grace period so SIGTERM finishes work in hand. PostgreSQL is a StatefulSet with a volume claim template rather than a Deployment, because the pod name and its volume must stay paired across restarts. A PodDisruptionBudget keeps one API pod up during node maintenance. The ConfigMap mirrors `.env.example`; the Secret is committed only as `secrets.example.yaml` with placeholder values, and the real one is applied by hand. The deploy workflow builds and pushes the image on merge and skips the rollout while no cluster credentials exist; a CI job renders both overlays and validates them with kubeconform.

### What Your Team Did With It

- Beyond the lecture: Kustomize overlays, the StatefulSet, the PodDisruptionBudget and probe tuning were not covered in class, so each was checked against the Kubernetes documentation before use, and the manifests were written from this layout, then rendered with `kubectl kustomize` and validated with kubeconform against the Kubernetes 1.33 and Gateway API schemas; the same check runs in CI on every pull request.
- Corrected: a `PGDATA` override in the first draft was removed because `compose.yaml` lets the `postgres:18` image choose its data directory under the mounted volume, and the two environments must match.
- Found on minikube the same day: both api pods had been restarted once, because the liveness probe pointed at `/health` and failed while PostgreSQL was still starting. A dependency outage must not kill a healthy process, so liveness now checks only that the socket accepts connections and readiness keeps the dependency check. The autoscaler's `minReplicas: 2` had also overridden the overlay's single replica; the overlay now sets it to 1. The restart test passed: a row written, `postgres-0` deleted, the row read back from the recreated pod on the same claim.

## Load test for the autoscaling extension (#69), 4 November 2026

### Prompt

For the autoscaling and high-availability extension in section 2.7, we need to step the request rate up against the deployed API and see when latency or errors climb, how many API replicas the HPA adds, and whether a rolling update under load drops requests. Can this be one script with no new dependencies, since the team runs it from different laptops?

### AI Response

A Node script using the built-in `fetch`: an open-loop request schedule at a fixed rate per step (so slow responses don't lower the offered load), p50 and p95 latency and the error rate per step, the ready replica count read with `kubectl` at the end of each step, and an optional mode that runs `kubectl rollout restart` halfway through a constant-load step and counts every failed request.

### What Your Team Did With It

- Checked locally against the API with PostgreSQL and Redis at 20 and 100 req/s (no errors, p95 10 and 22 ms); the replicas column shows "-" without cluster access, which is the intended fallback.
- Changed: the step-length variable is `STEP_SECONDS`, not `SECONDS`, because `SECONDS` is a built-in bash variable.
- Not yet run on DigitalOcean: that needs the cluster from #54, and the results table goes into `docs/loadtest/` for the presentation and the final report.
