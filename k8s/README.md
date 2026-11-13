# k8s

Kubernetes manifests, applied with `kubectl apply -k` (Kustomize) in two overlays: `minikube/` for laptops and `doks/` for the cluster.

```
k8s/
  base/        Namespace, ConfigMap, StatefulSet (postgres) with its volume claim, Deployment (redis),
               Deployment + Service + HorizontalPodAutoscaler + PodDisruptionBudget (api), Deployment (worker),
               secrets.example.yaml (the shape of the one Secret, placeholders only; real values are never committed)
  minikube/    overlay: one api replica, image built inside minikube, NodePort
  doks/        overlay: DigitalOcean block-storage class for the database, Gateway and HTTPRoute for traffic
```

`web` gets its Deployment when that container exists; the backup CronJob lands with the backup slice.

## Run on minikube

```
minikube start --cpus 2 --memory 4096
minikube image build -t contentcollab-api:dev api
minikube image build -t contentcollab-worker:dev worker
kubectl apply -f k8s/base/namespace.yaml
KUBE_CONTEXT=minikube scripts/app-secret.sh                  # the app Secret, from no file; asks for the Spaces key in a terminal (below). Name the context: the current one may be the real cluster
kubectl apply -k k8s/minikube
kubectl -n contentcollab get pods -w                         # wait for postgres, redis and api to be Running and 1/1
minikube service api -n contentcollab --url                  # then open <url>/health
```

The restart test from the proposal: `kubectl -n contentcollab delete pod postgres-0`, wait for it to come back, and the data is still there because the claim `data-postgres-0` outlived the pod.

Validate without a cluster: `kubectl kustomize k8s/minikube` renders the objects; CI runs kubeconform on them (`ci.yml`, job `k8s`).

## Cluster

`scripts/cluster-up.sh` creates the DOKS cluster and installs what the `doks` overlay expects (Gateway API CRDs, NGINX Gateway Fabric, cert-manager with the Let's Encrypt issuer in `doks/cluster-issuer.yaml`), applies the Secret from `k8s/base/secrets.yaml` (git-ignored; see the next section for how to treat it) and the overlay, and prints the load balancer address for the DNS record. Needs `doctl`, `kubectl`, `helm` and `LETSENCRYPT_EMAIL`; it bills from the moment it runs. With `DATADOG_API_KEY` in the environment it also installs the Datadog agent from `doks/datadog-values.yaml` (container logs from the `contentcollab` namespace, Kubernetes state, the API's `/metrics` by autodiscovery); set the key with `read -rs DATADOG_API_KEY && export DATADOG_API_KEY` so it stays out of the shell history, and re-run the script to rotate it. `scripts/cluster-down.sh` deletes it all after grading.

## Object storage and the app Secret (#53)

Files live in one private Spaces bucket in TOR1. The API and the worker reach it with one access key limited to that bucket. Decision, options not taken and sources: [BUILD_LOG](../docs/BUILD_LOG.md), 11 November. Spaces keys can only be created in the Control Panel, so two of these steps (2 and 3) are clicks:

1. `doctl auth init`, then `scripts/do-project.sh` creates the project `ContentCollab`, or finds it.
2. Control Panel, **Spaces Object Storage**, **Create Bucket**: region **TOR1**, **Standard Storage**, CDN off, name `contentcollab`, project `ContentCollab`. Bucket names are unique across all DigitalOcean accounts: if the name is taken, pick another and change `SPACES_BUCKET` in `k8s/base/configmap.yaml` and in your local environment, and use it below.
3. **Access Keys**, **Create Access Key**: **Limited access**, the bucket from step 2, permission **Read/Write/Delete**, name `contentcollab-app`. The secret half is shown once. Copy it into your terminal with `read -rs`, nowhere else.
4. Check the key: `read -rs SPACES_SECRET && export SPACES_SECRET`, `export SPACES_KEY=<the access key>`, then `scripts/spaces-verify.sh` (needs the AWS CLI v2 and curl). It puts, uploads in parts, copies and deletes objects under `probe/` and confirms an anonymous read is refused. To prove the key reaches only this bucket, create a second, empty bucket (the backup job's will do, once it exists; it costs nothing extra) and run it with `FOREIGN_BUCKET=<that bucket>`. A bucket that does not exist makes the step fail, since that proves nothing.
5. The app Secret: `scripts/app-secret.sh` (on minikube with the namespace applied first). It generates `DB_PASSWORD` and `JWT_SECRET` the first time and keeps them on every later run (PostgreSQL stores its password when its volume is first created), and takes the Spaces key from the environment or asks for it. Nothing is written to a file or printed. On DOKS the order is awkward until `cluster-up.sh` calls `app-secret.sh` (a follow-up to #54, which is rewriting that script). Today `cluster-up.sh` refuses to start without `k8s/base/secrets.yaml` and applies it with client-side apply, which leaves every value in plain text in an annotation and overwrites whatever is in the cluster. So: (a) copy the template to `k8s/base/secrets.yaml` (git-ignored) and fill in the values you intend to keep, with a real `DB_PASSWORD` and `JWT_SECRET`, never `REPLACE_ME` (PostgreSQL stores the password the first time it starts); (b) run `cluster-up.sh`; (c) run `KUBE_CONTEXT=<the cluster's context> scripts/app-secret.sh` after the bring-up, and again after every later `cluster-up.sh` run, since each run re-applies the file. It keeps the values and removes the annotation. `app-secret.sh` stops if the Secret holds `REPLACE_ME`.

To rotate the Spaces key without an outage, create a second key as in step 3, run `RESTART=1 scripts/app-secret.sh` with the new values exported (the pods read the Secret only when they start), check it with `scripts/spaces-verify.sh`, then delete the old key. Regenerating a key's secret in place stops the old one at once, so uploads fail until the pods restart. Changing `JWT_SECRET` logs everyone out; `DB_PASSWORD` cannot be changed through the Secret alone (it needs `ALTER USER` in PostgreSQL first). Taking the annotation off does not un-expose values that an earlier client-side apply wrote there: treat them as seen by everyone with cluster access, and rotate the Spaces key and `JWT_SECRET` if the cluster was shared.

Who can read the values: anyone allowed to `get`, `list` or `watch` secrets in the `contentcollab` namespace, to create a pod there (a pod can mount the Secret) or to `exec` into `api` or `worker` (the values are in their environment); on DOKS, anyone holding the cluster's kubeconfig. Base64 is not encryption (SEC-10), so that kubeconfig and the DigitalOcean token stay with the cluster owner. `scripts/secret-template.test.mjs` catches the common mistakes (a real value or a `data:` section in the template, a literal on a secret-looking variable, a `secretGenerator`, the storage keys or the whole Secret going to anything but `api` and `worker`, a token-shaped string in a tracked file). It reads text, not YAML, so it is a net, not a proof; review changes under `k8s/` for Secrets all the same.

Teardown: `scripts/cluster-down.sh` does not touch Spaces. The bucket keeps billing (US$5 a month covers 250 GiB stored and 1,024 GiB of transfer) until it is destroyed in the Control Panel, which deletes its files. Do that on purpose, after the final `pg_dump` (DB-12, INF-7), and delete the key `contentcollab-app` with it: keys outlive the cluster.

## Images

CI (`.github/workflows/deploy.yml`) pushes `ghcr.io/nabeegh-khan/contentcollab-api` and `contentcollab-worker`, tagged `<sha>` and `latest` (the registry keeps `latest` for laptops; nothing in `k8s/` uses it), on every merge to `main`. The base manifests carry the placeholder tag `unpinned`, which is not a real tag: the minikube overlay replaces it with `dev`, and the rollout step runs `kustomize edit set image` to the commit SHA in `k8s/doks` before a single `kubectl apply -k k8s/doks`. If a Deployment does not become ready within 180 s the step runs `kubectl rollout undo` on it and fails the job; one left on `unpinned` (a pin that matched nothing) fails the job, and is undone the same way once its rollout fails to turn ready, which it cannot while that tag does not exist in the registry. Once the `SMOKE_URL` repository variable is set the job also checks `/health` and undoes both on failure. The job needs the `DIGITALOCEAN_ACCESS_TOKEN` repository secret (set on 11 November; without it the job warns and stops, green); a SHA is never pinned by editing the manifest. `tests/test_k8s_deploy.py` checks the pinning, the undo and the named API port (`http`, used by both probes; the Service `targetPort` stays 3000 until pods with the named port run, BUILD_LOG.md 11 November) in the `k8s` CI job.
<!-- PRACTICES:start -->

## Practices that apply here

From [`docs/PRACTICES.md`](../docs/PRACTICES.md) (generated by `scripts/sync-practices.py`; edit the source, not this list). Paste this section into whatever tool you write code with.

| ID | Practice | Here |
|---|---|---|
| INF-1 | Pick the service model on purpose: IaaS when you need the OS, PaaS when you want to hand off the hosts, FaaS for small event-driven pieces. More abstraction means less to manage and less control | We run on managed Kubernetes (the provider runs the control plane, we run the containers), object storage as a service for files, and optionally a serverless function for one background job. Heavy VM work was A1; the project is not that |
| INF-2 | Read machine-specific values at runtime (environment variables, `PORT`), never hard-code them | The same image runs in Compose, minikube and the cluster |
| INF-3 | Script cloud tasks through the CLI or API and stop early if a required variable is missing | Cluster setup, volume creation and backups live in `scripts/`, not in dashboard clicks; `cluster-up.sh` checks its tools, the doctl sign-in and every variable before it changes anything, and `DRY_RUN=1` prints the changes instead of making them (D13) |
| INF-4 | Declare the desired state (replicas) and let the orchestrator replace failed instances and route traffic | API Deployment with replicas, a Service in front, readiness probes |
| INF-5 | Roll out updates gradually with versioned image tags; keep the manifest's tag in step | CI tags images by commit SHA; a rollout can be undone with one command |
| INF-6 | Deploy near users and know the cold-start cost | The API never scales to zero. Toronto was the plan, but the 11 November rebuild put the cluster in nyc3 after tor1 capacity errors, so this is not met for the cluster (D13) |
| INF-7 | Destroy what you are not using; stopped machines and detached volumes still bill | Cluster deleted after grades; a budget line in the proposal |
| INF-8 | A Deployment owns a ReplicaSet that keeps the replica count, so a deleted pod is replaced; the selector must match the pod template's labels, and a Service routes only to ready pods it selects | API and worker Deployments; Service selectors match `app:` labels |
| INF-9 | Explicit image tags in the cluster, never `:latest`; watch with `kubectl rollout status`, recover with `kubectl rollout undo` | CI sets the commit SHA on every rollout; the bring-up pins the image built from `main`; automatic undo on a failed smoke check (#70) |
| INF-10 | Name container ports and refer to them by name in Services and probes, so each port number is written once | `http` on the api and the worker |
| INF-11 | A readiness probe gates traffic and never restarts the container; restarts are the liveness probe's job | Readiness on `/health` (dependencies), liveness on the socket only |
| INF-12 | Separate compute from storage: a stateful pod keeps its data on a PersistentVolumeClaim, not in the container's writable filesystem, so a replacement pod mounts the same data | PostgreSQL's mount `/var/lib/postgresql`, which holds its data directory, is on a claim; the restart test planned in D15 (#68, open) checks that a replaced pod reads the same rows |
| INF-13 | Ask for storage through a claim that names its StorageClass, size and access mode, and let the provisioner create the volume (dynamic provisioning). ReadWriteOnce means one node, not one pod, and does not make concurrent writes safe | `do-block-storage`, ReadWriteOnce, 5 GiB, set in the `doks` overlay; only PostgreSQL mounts a claim, and uploads are to go to Spaces (D2, not built yet), not to a shared volume |
| INF-14 | Know the reclaim policy: with Delete, deleting the claim deletes the volume and its data; Retain keeps them for manual recovery | `do-block-storage` reclaims with Delete, so deleting the claim or the namespace deletes the database volume. Moving it to Retain is #104 (D15). Deleting the cluster is a separate path: `scripts/cluster-down.sh` passes `--dangerous`, which the doctl reference says deletes the cluster's volumes, with no exception for Retain (#104). Retain is not a backup (DB-3) |
| INF-15 | A database pod with its own identity and storage runs as a StatefulSet, which gives each replica a stable name and its own claim; a Deployment on a ReadWriteOnce volume uses the Recreate strategy so the old pod stops before the new one starts. A StatefulSet does not set up replication | PostgreSQL is a one-replica StatefulSet with a claim from `volumeClaimTemplates` (D2). There is no replication, so the recovery path is a backup, a stretch goal in #50 (open) and not built yet |
| INF-16 | A highly available control plane runs several control-plane nodes behind a load balancer, with etcd replicated; without one, running workloads may carry on but scheduling and cluster changes are disrupted | DigitalOcean runs the control plane. Its HA option was on for our first cluster by DigitalOcean's default, not by a design decision; the 11 November rebuild created the cluster again without it, since the course does not need it (D13, `docs/COST_PLAN.md`). Our availability work is on the workload side: two API replicas spread across nodes when the pool has two (it autoscales from one to two, D13), probes and a PodDisruptionBudget |
| INF-17 | Functions as a service suit short-lived, event-driven work (an HTTP endpoint, a file or message to process, a notification, a scheduled job), not a long-running service or a database. The costs are cold starts, execution time and resource limits, and less control over the runtime | The API, the worker and PostgreSQL run continuously in the cluster. A function stays optional for one occasional job (INF-1); DigitalOcean Functions bill by memory and run time, with 90,000 GiB-seconds free a month |
| INF-18 | Choose the rollout strategy on purpose. A rolling update replaces instances gradually, so old and new versions run side by side for a while; blue-green runs two environments and switches traffic only after the new one passes its health checks, at the cost of double infrastructure; canary sends a small share of traffic to the new version first | The API rolls with `maxUnavailable: 0, maxSurge: 1`, so old and new pods serve together during a rollout. A migration Job is planned to run before the rollout (ARCHITECTURE diagram, not built yet); nothing yet requires a migration to keep the previous version working (#105) |
| INF-19 | Reach pods through a Service, never through pod IPs, which change when pods are replaced. A Service selects pods by label and gives them a stable name and cluster IP. ClusterIP is for traffic inside the cluster, LoadBalancer for traffic from outside; `kubectl port-forward` is for local testing only and exposes nothing publicly | The API reaches PostgreSQL and Redis by Service name (`DB_HOST: postgres`, `REDIS_HOST: redis`); On DOKS, `api`, `postgres` (headless) and `redis` are cluster-internal and the only way in from outside is the Gateway, whose address is a DigitalOcean load balancer (D11, `scripts/cluster-up.sh`); the minikube overlay makes `api` a NodePort for local testing |
| INF-20 | kubectl acts on the current context in the kubeconfig (a cluster, a user and a namespace): check it before a command that changes anything | CI saves one short-lived kubeconfig per run, so it has a single context (D13). Local scripts `metrics-server.sh`, `hpa-ready.mjs` and `loadtest.mjs` use whatever context is current without checking it, and `cluster-up.sh` selects its cluster's context but never confirms it (#106) |
| INF-21 | Choose the deployment model on purpose: a public cloud for access, scaling and cost, at the price of less control; several providers only when the gain outweighs the extra operational complexity | One public cloud, DigitalOcean: the cluster and the database volume, with Spaces planned for files (D2, not built yet); no second infrastructure provider |
| CON-1 | One container per responsibility | api, web, postgres, redis, worker are separate services |
| CON-2 | In the Dockerfile copy the package manifests and install before copying the code, so the dependency layer is cached | Every Dockerfile in the repo |
| CON-3 | Pin base image versions (`node:24`, `postgres:18`, `redis:8`) | Rebuilds produce the same environment |
| CON-4 | Healthchecks on every service; dependents start on `condition: service_healthy` | Compose locally; readiness and liveness probes in Kubernetes |
| CON-5 | `init.sql` runs only on an empty data directory; after that, schema changes are migrations | Versioned migrations from the first week |
| CON-6 | Rebuild after code changes (`up --build`); plain `up` reuses the old image | Written into the README's local setup |
| CON-7 | Services reach each other by service name; publish only the ports outside clients need | Postgres and Redis are never published; only the Ingress is public |
| SEC-1 | Secrets in environment or a secret store, never in code or images; commit only `.env.example` | `.env` is ignored; Kubernetes Secrets in the cluster |
| SEC-2 | Prefer file-mounted secrets to environment variables for passwords and keys, and grant each secret only to the service that needs it | Database password mounted into api and worker only; Spaces keys into api and worker; nothing into web |
| SEC-5 | Force HTTPS | TLS at the Gateway with cert-manager and Let's Encrypt; `cluster-up.sh` exits 1 if the certificate is not issued once DNS points at the Gateway (D11, D13) |
| SEC-6 | Run as a non-root user; SSH with keys only | Dockerfiles set a non-root user; pods run with `runAsNonRoot` |
| SEC-8 | Restrict network paths: firewall, private network, no public database port | Postgres and Redis on ClusterIP Services only |
| DB-2 | Block storage for the database, object storage for files served over HTTP; a managed database alone is not "persistent storage" in this course | Postgres on a PersistentVolumeClaim; uploads in Spaces |
| DB-3 | Volumes are not backups and not shared storage | Nightly `pg_dump` to Spaces; files never written to a pod's disk |
| DB-12 | Delete persistent data only on purpose (`down -v`, volume delete) | Never against demo data |
| API-7 | Handle shutdown signals: stop accepting requests, finish in-flight ones, close the database pool | Rolling updates and autoscaling drop no requests |
| API-8 | Health endpoint that the platform checks; readiness separate from liveness | `/health` for liveness; readiness only once Postgres and Redis answer |
| OBS-1 | Log each request with time, method, path and status | Structured JSON logs so Kubernetes can collect them |
| OBS-2 | Read the logs before changing code | `kubectl logs` first |
| OBS-3 | Monitor CPU, memory and disk with provider tools and set alerts | DigitalOcean alert policies at 80% |
| OBS-4 | Expose application metrics | `/metrics` with request count, latency, errors, connected sockets |
| OBS-5 | Set resource requests and limits per container so one runaway pod cannot starve the node | Every Deployment |

<!-- PRACTICES:end -->
