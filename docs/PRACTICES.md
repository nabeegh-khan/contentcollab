# Engineering practices for ContentCollab

What the course has taught so far about building systems that keep running, collected in one place so the proposal, the code reviews and the presentation Q&A all draw on the same list. "L5 p27" means ECE1779 lecture 5 slides, PDF page 27. A1 to A3 are the course assignments. Rows get added as lectures and assignments cover more (through lecture 9 as of 11 November); anyone on the team can add one.

Each row says what we do, where it comes from, and where in ContentCollab it applies. If a pull request breaks one of these, the review says which ID.

## Service model and infrastructure

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| INF-1 | Pick the service model on purpose: IaaS when you need the OS, PaaS when you want to hand off the hosts, FaaS for small event-driven pieces. More abstraction means less to manage and less control | L1 p77-81, L2 p6-10, L3 p86, L6 p45-47 | We run on managed Kubernetes (the provider runs the control plane, we run the containers), object storage as a service for files, and optionally a serverless function for one background job. Heavy VM work was A1; the project is not that |
| INF-2 | Read machine-specific values at runtime (environment variables, `PORT`), never hard-code them | A1 handout, L3 p6-7, L6 p56 | The same image runs in Compose, minikube and the cluster |
| INF-3 | Script cloud tasks through the CLI or API and stop early if a required variable is missing | L2 p36, L3 p61-65, p72 | Cluster setup, volume creation and backups live in `scripts/`, not in dashboard clicks; `cluster-up.sh` checks its tools, the doctl sign-in and every variable before it changes anything, and `DRY_RUN=1` prints the changes instead of making them (D13) |
| INF-4 | Declare the desired state (replicas) and let the orchestrator replace failed instances and route traffic | L5 p59-61, p69-71, L6 p15-23 | API Deployment with replicas, a Service in front, readiness probes |
| INF-5 | Roll out updates gradually with versioned image tags; keep the manifest's tag in step | L4 p58-59, L5 p72, L6 p29-30 | CI tags images by commit SHA; a rollout can be undone with one command |
| INF-6 | Deploy near users and know the cold-start cost | L6 p47, p63-64, p73-74 | Toronto region; the API never scales to zero |
| INF-7 | Destroy what you are not using; stopped machines and detached volumes still bill | L3 p3, L6 p53, A1 handout | Cluster deleted after grades; a budget line in the proposal |
| INF-8 | A Deployment owns a ReplicaSet that keeps the replica count, so a deleted pod is replaced; the selector must match the pod template's labels, and a Service routes only to ready pods it selects | L8 p23-31, p43, p83 | API and worker Deployments; Service selectors match `app:` labels |
| INF-9 | Explicit image tags in the cluster, never `:latest`; watch with `kubectl rollout status`, recover with `kubectl rollout undo` | L8 p53-55, p67, p73 | CI sets the commit SHA on every rollout; the bring-up pins the image built from `main`; automatic undo on a failed smoke check (#70) |
| INF-10 | Name container ports and refer to them by name in Services and probes, so each port number is written once | L8 p76-81, p91-92 | `http` on the api and the worker |
| INF-11 | A readiness probe gates traffic and never restarts the container; restarts are the liveness probe's job | L8 p106-111 | Readiness on `/health` (dependencies), liveness on the socket only |
| INF-12 | Separate compute from storage: a stateful pod keeps its data on a PersistentVolumeClaim, not in the container's writable filesystem, so a replacement pod mounts the same data | L9 p5-8, p15, p24 | PostgreSQL's mount `/var/lib/postgresql`, which holds its data directory, is on a claim; the restart test planned in D15 (#68, open) checks that a replaced pod reads the same rows |
| INF-13 | Ask for storage through a claim that names its StorageClass, size and access mode, and let the provisioner create the volume (dynamic provisioning). ReadWriteOnce means one node, not one pod, and does not make concurrent writes safe | L9 p9-12, p17-19, p25 | `do-block-storage`, ReadWriteOnce, 5 GiB, set in the `doks` overlay; only PostgreSQL mounts a claim, and uploads are to go to Spaces (D2, not built yet), not to a shared volume |
| INF-14 | Know the reclaim policy: with Delete, deleting the claim deletes the volume and its data; Retain keeps them for manual recovery | L9 p29, p38 | `do-block-storage` reclaims with Delete, so deleting the claim or the namespace deletes the database volume. Moving it to Retain is #104 (D15). Deleting the cluster is a separate path: `scripts/cluster-down.sh` passes `--dangerous`, which the doctl reference says deletes the cluster's volumes, with no exception for Retain (#104). Retain is not a backup (DB-3) |
| INF-15 | A database pod with its own identity and storage runs as a StatefulSet, which gives each replica a stable name and its own claim; a Deployment on a ReadWriteOnce volume uses the Recreate strategy so the old pod stops before the new one starts. A StatefulSet does not set up replication | L9 p22, p41-42 | PostgreSQL is a one-replica StatefulSet with a claim from `volumeClaimTemplates` (D2). There is no replication, so the recovery path is a backup, a stretch goal in #50 (open) and not built yet |
| INF-16 | A highly available control plane runs several control-plane nodes behind a load balancer, with etcd replicated; without one, running workloads may carry on but scheduling and cluster changes are disrupted | L9 p44-52 | DigitalOcean runs the control plane. Its HA option was on for our first cluster by DigitalOcean's default, not by a design decision; the 11 November rebuild created the cluster again without it, since the course does not need it (D13, `docs/COST_PLAN.md`). Our availability work is on the workload side: two API replicas spread across nodes when the pool has two (it autoscales from one to two, D13), probes and a PodDisruptionBudget |
| INF-17 | Functions as a service suit short-lived, event-driven work (an HTTP endpoint, a file or message to process, a notification, a scheduled job), not a long-running service or a database. The costs are cold starts, execution time and resource limits, and less control over the runtime | L9 p54-57, p69-74, p77 | The API, the worker and PostgreSQL run continuously in the cluster. A function stays optional for one occasional job (INF-1); DigitalOcean Functions bill by memory and run time, with 90,000 GiB-seconds free a month |

## Containers and local development

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| CON-1 | One container per responsibility | L4 p73-74 | api, web, postgres, redis, worker are separate services |
| CON-2 | In the Dockerfile copy the package manifests and install before copying the code, so the dependency layer is cached | L4 p47-48, p104 | Every Dockerfile in the repo |
| CON-3 | Pin base image versions (`node:24`, `postgres:18`, `redis:8`) | L4 p48, p84, A2 handout | Rebuilds produce the same environment |
| CON-4 | Healthchecks on every service; dependents start on `condition: service_healthy` | L4 p110, L5 p44-52, A2 handout | Compose locally; readiness and liveness probes in Kubernetes |
| CON-5 | `init.sql` runs only on an empty data directory; after that, schema changes are migrations | L4 p99-100 | Versioned migrations from the first week |
| CON-6 | Rebuild after code changes (`up --build`); plain `up` reuses the old image | L5 p11, p16 | Written into the README's local setup |
| CON-7 | Services reach each other by service name; publish only the ports outside clients need | L4 p86-92, A2 handout | Postgres and Redis are never published; only the Ingress is public |

## Secrets and security

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| SEC-1 | Secrets in environment or a secret store, never in code or images; commit only `.env.example` | L2 p72, L3 p30-31, L5 p19-25, project handout | `.env` is ignored; Kubernetes Secrets in the cluster |
| SEC-2 | Prefer file-mounted secrets to environment variables for passwords and keys, and grant each secret only to the service that needs it | L5 p27-42, L6 p80-81 (Fly.io secrets are app-wide: a stated trade-off) | Database password mounted into api and worker only; Spaces keys into api and worker; nothing into web |
| SEC-3 | The app connects as its own database role with only the grants it needs, never the superuser | L2 p74-75, A1 handout | `contentcollab` role owns one database |
| SEC-4 | Protect API routes with a token in the `Authorization` header; leave only `/health` public | L1 p80, L6 p49-50, p77 (A3) | JWT on every route except health and sign-in |
| SEC-5 | Force HTTPS | L6 p62 | TLS at the Gateway with cert-manager and Let's Encrypt; `cluster-up.sh` exits 1 if the certificate is not issued once DNS points at the Gateway (D11, D13) |
| SEC-6 | Run as a non-root user; SSH with keys only | L2 p49-50, A1 handout | Dockerfiles set a non-root user; pods run with `runAsNonRoot` |
| SEC-7 | Escape stored text before rendering it as HTML | A1 (query page) | Comment bodies and filenames are rendered as text, never injected as HTML |
| SEC-8 | Restrict network paths: firewall, private network, no public database port | L2 p29-34 | Postgres and Redis on ClusterIP Services only |
| SEC-9 | Share links carry a random token and an expiry, and the role check runs on every request, not only when the link is created | project idea (link access limited to the people shared with) | `shares` table, role middleware |
| SEC-10 | A Kubernetes Secret is base64, not encryption: keep real values out of Git and out of images, and treat anyone with cluster access as able to read them | L8 p99-105 | `k8s/base/secrets.yaml` is git-ignored; the cluster token and kubeconfig stay with the cluster owner; CI gets a kubeconfig that expires after 600 seconds, never a stored one (D13) |

## Data

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| DB-1 | Persist in a database, not in process memory | A2 handout | Nothing the user created lives only in a container |
| DB-2 | Block storage for the database, object storage for files served over HTTP; a managed database alone is not "persistent storage" in this course | L2 p23-27, L3 p33-34, project handout | Postgres on a PersistentVolumeClaim; uploads in Spaces |
| DB-3 | Volumes are not backups and not shared storage | L2 p37, L3 p15-16, L6 p86-87, A1 handout | Nightly `pg_dump` to Spaces; files never written to a pod's disk |
| DB-4 | Parameterized queries only | A2 | Every query |
| DB-5 | Order every list query explicitly | A1, A2 | `ORDER BY id` or `created_at` on every list |
| DB-6 | Multi-step writes in one transaction | general practice (the A2 handout does not mention transactions) | Creating a version and its metadata. Lists return no total (API-4), so there is no page-and-total read to keep consistent |
| DB-7 | Return the row as stored (`RETURNING`), not an echo of the request | A2 | Every create and update |
| DB-8 | A cache is a copy; the database is the source of truth, and a missing cache key is re-seeded, never read as zero | A2 (Redis `taskCount`) | Redis holds socket state and counters only |
| DB-9 | Rules in the schema as well as the API: `NOT NULL`, `CHECK`, foreign keys, timestamp defaults | A1 schema | Roles constrained to three values; every row timestamped |
| DB-10 | Enforce relationship rules in the API with a clear error | A2-style constraint errors | A document's last Owner cannot be removed |
| DB-11 | Find-or-create lookups run one at a time, never fanned out in parallel | team experience, October 2026 | Inviting a user who may already exist |
| DB-12 | Delete persistent data only on purpose (`down -v`, volume delete) | L4 p108, L5 p15, L6 p94 | Never against demo data |
| DB-13 | Keep notifications and other event state where they survive a restart and every replica can read them; a list in process memory is lost on restart and not shared between machines | L9 p80-82, p93 | Shared across replicas: real-time events are to reach every API pod through the Socket.IO Redis adapter (D4, not built yet), which stores nothing. Durable: comments are to be rows in PostgreSQL (D2, not built yet), and email on share and on mention is a stretch goal (#44, open). Gap against this row: there is no stored notification list, so an event sent while a client is offline is not kept |

## API design, validation and robustness

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| API-1 | REST resources, standard methods, stateless requests, JSON bodies, status codes that match the outcome | A1, A2 handouts | The endpoint table in `docs/API.md` |
| API-2 | One fixed JSON error shape; details to the log, a generic 500 to the client | A2 handout, A2 starter error handler | `{ error, message }` or `{ error, messages }` |
| API-3 | Body, params and query are untrusted: parse, validate, then use; report every validation error at once; check in a fixed order (ID format, body, existence, business rule) | A1, A2 handouts | Validation middleware on every route |
| API-4 | Paginate every list except `GET /tags` (a bare array, `docs/API.md`) with a default and a maximum page size: `?limit=` (default 20, max 100) and an opaque `?cursor=` from the previous page, returning `{ items, nextCursor }`, with `nextCursor` a string or `null`. Lists are newest first unless stated | `docs/API.md` "Pagination" (our contract, API-10); general practice. No lecture or assignment (A1 to A3) sets a pagination scheme | Documents, versions, comments, search results. No `total` or `offset`: a cursor stays correct when rows are added between pages |
| API-5 | Keep slow work off the request path: uploads stream to object storage, imports and thumbnails run in a worker | general Node practice; A3 health checks assume a responsive process | An upload never sits in memory; a bulk import never blocks a request |
| API-6 | Limit what one request can do: body size cap, allowed content types, upload size cap, rate limit per user | general practice; project handout (robustness) | A 2 GB upload or a flood of requests cannot take the API down |
| API-7 | Handle shutdown signals: stop accepting requests, finish in-flight ones, close the database pool | L6 p24-26 (Swarm replaces tasks), Kubernetes rolling updates | Rolling updates and autoscaling drop no requests |
| API-8 | Health endpoint that the platform checks; readiness separate from liveness | L5 p45, L6 p49 | `/health` for liveness; readiness only once Postgres and Redis answer |
| API-9 | Idempotent writes where a retry is possible: an import skips a file whose checksum already exists | general practice | Bulk import, repeated uploads of the same file |
| API-10 | Document the API as a contract so slices can be built in parallel | project handout | `docs/API.md` before feature work starts |

## Testing and CI

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| TST-1 | Export the app without starting the server; tests drive it on a free port against a reset test database, serially | A2 sample tests | Jest and Supertest with a Postgres service container in CI |
| TST-2 | Write tests beyond the samples; assert exact codes, messages and shapes | A1, A2 handouts | Every route has a test for the happy path and each error |
| TST-3 | Probe what the tests skip with a curl script and read the bodies | team experience, October 2026 | `scripts/smoke.sh` run before every demo |
| TST-4 | Verify persistence by restarting the stack | A2 handout, L6 p92 | The restart test is a rehearsed demo step |
| TST-5 | Tests run in CI on every pull request; `main` is deployable | project handout (CI/CD) | GitHub Actions |

## Monitoring and debugging

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| OBS-1 | Log each request with time, method, path and status | A2 starter logger | Structured JSON logs so Kubernetes can collect them |
| OBS-2 | Read the logs before changing code | L2 p70-71, L4 p62, L6 p69 | `kubectl logs` first |
| OBS-3 | Monitor CPU, memory and disk with provider tools and set alerts | L2 p37, L6 p69, project handout | DigitalOcean alert policies at 80% |
| OBS-4 | Expose application metrics | project handout (optional Prometheus and Grafana) | `/metrics` with request count, latency, errors, connected sockets |
| OBS-5 | Set resource requests and limits per container so one runaway pod cannot starve the node | Kubernetes practice | Every Deployment |

## Design and process

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| DES-1 | Choose from requirements and constraints and write the trade-off down | project handout (rubric) | `docs/ARCHITECTURE.md` decisions |
| DES-2 | Know the load-bearing pieces (schema, API contract, auth middleware) and change them only with tests in place and the team told | general practice | Listed in `docs/ARCHITECTURE.md` |
| DES-3 | Scope for depth: a finished focused system beats a broad shallow one | project handout | The out-of-scope list |
| DES-4 | Modules with one job each: routes, validation, services, data access, realtime, storage client | A2 starter layout | `src/` layout |
| PRC-1 | One Issue per task, one branch per Issue, small pull requests with one review for code; docs straight to `main` | course GitHub guide | README, How we work |
| PRC-2 | Everyone commits their own work; contribution is read from Git history | project handout | Slices in `docs/PLAN.md` |
| PRC-3 | Record AI use in `ai-session.md`: the prompt, the response, what we did with it and how we checked it | course AI policy | Final deliverable |
| PRC-4 | Demo live; recordings only as backup | project handout | Presentation |
