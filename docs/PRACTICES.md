# Engineering practices for ContentCollab

What the course has taught so far about building systems that keep running, collected in one place so the proposal, the code reviews and the presentation Q&A all draw on the same list. "L5 p27" means ECE1779 lecture 5 slides, PDF page 27. A1 and A2 are the course assignments. Rows get added as lectures and assignments cover more; anyone on the team can add one.

Each row says what we do, where it comes from, and where in ContentCollab it applies. If a pull request breaks one of these, the review says which ID.

## Service model and infrastructure

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| INF-1 | Pick the service model on purpose: IaaS when you need the OS, PaaS when you want to hand off the hosts, FaaS for small event-driven pieces. More abstraction means less to manage and less control | L1 p77-81, L2 p6-10, L3 p86, L6 p45-47 | We run on managed Kubernetes (the provider runs the control plane, we run the containers), object storage as a service for files, and optionally a serverless function for one background job. Heavy VM work was A1; the project is not that |
| INF-2 | Read machine-specific values at runtime (environment variables, `PORT`), never hard-code them | A1 handout, L3 p6-7, L6 p56 | The same image runs in Compose, minikube and the cluster |
| INF-3 | Script cloud tasks through the CLI or API and stop early if a required variable is missing | L2 p36, L3 p61-65, p72 | Cluster setup, volume creation and backups live in `scripts/`, not in dashboard clicks |
| INF-4 | Declare the desired state (replicas) and let the orchestrator replace failed instances and route traffic | L5 p59-61, p69-71, L6 p15-23 | API Deployment with replicas, a Service in front, readiness probes |
| INF-5 | Roll out updates gradually with versioned image tags; keep the manifest's tag in step | L4 p58-59, L5 p72, L6 p29-30 | CI tags images by commit SHA; a rollout can be undone with one command |
| INF-6 | Deploy near users and know the cold-start cost | L6 p47, p63-64, p73-74 | Toronto region; the API never scales to zero |
| INF-7 | Destroy what you are not using; stopped machines and detached volumes still bill | L3 p3, L6 p53, A1 handout | Cluster deleted after grades; a budget line in the proposal |

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
| SEC-5 | Force HTTPS | L6 p62 | TLS at the Ingress with cert-manager |
| SEC-6 | Run as a non-root user; SSH with keys only | L2 p49-50, A1 handout | Dockerfiles set a non-root user; pods run with `runAsNonRoot` |
| SEC-7 | Escape stored text before rendering it as HTML | A1 (query page) | Comment bodies and filenames are rendered as text, never injected as HTML |
| SEC-8 | Restrict network paths: firewall, private network, no public database port | L2 p29-34 | Postgres and Redis on ClusterIP Services only |
| SEC-9 | Share links carry a random token and an expiry, and the role check runs on every request, not only when the link is created | project idea (link access limited to the people shared with) | `shares` table, role middleware |

## Data

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| DB-1 | Persist in a database, not in process memory | A2 handout | Nothing the user created lives only in a container |
| DB-2 | Block storage for the database, object storage for files served over HTTP; a managed database alone is not "persistent storage" in this course | L2 p23-27, L3 p33-34, project handout | Postgres on a PersistentVolumeClaim; uploads in Spaces |
| DB-3 | Volumes are not backups and not shared storage | L2 p37, L3 p15-16, L6 p86-87, A1 handout | Nightly `pg_dump` to Spaces; files never written to a pod's disk |
| DB-4 | Parameterized queries only | A2 | Every query |
| DB-5 | Order every list query explicitly | A1, A2 | `ORDER BY id` or `created_at` on every list |
| DB-6 | Multi-step writes in one transaction; a page and its total read in one transaction | A2 | Creating a version and its metadata; list endpoints |
| DB-7 | Return the row as stored (`RETURNING`), not an echo of the request | A2 | Every create and update |
| DB-8 | A cache is a copy; the database is the source of truth, and a missing cache key is re-seeded, never read as zero | A2 (Redis `taskCount`) | Redis holds socket state and counters only |
| DB-9 | Rules in the schema as well as the API: `NOT NULL`, `CHECK`, foreign keys, timestamp defaults | A1 schema | Roles constrained to three values; every row timestamped |
| DB-10 | Enforce relationship rules in the API with a clear error | A2-style constraint errors | A document's last Owner cannot be removed |
| DB-11 | Find-or-create lookups run one at a time, never fanned out in parallel | team experience, October 2026 | Inviting a user who may already exist |
| DB-12 | Delete persistent data only on purpose (`down -v`, volume delete) | L4 p108, L5 p15, L6 p94 | Never against demo data |

## API design, validation and robustness

| ID | Practice | Source | Where it applies |
|---|---|---|---|
| API-1 | REST resources, standard methods, stateless requests, JSON bodies, status codes that match the outcome | A1, A2 handouts | The endpoint table in `docs/API.md` |
| API-2 | One fixed JSON error shape; details to the log, a generic 500 to the client | A2 handout, A2 starter error handler | `{ error, message }` or `{ error, messages }` |
| API-3 | Body, params and query are untrusted: parse, validate, then use; report every validation error at once; check in a fixed order (ID format, body, existence, business rule) | A1, A2 handouts | Validation middleware on every route |
| API-4 | Paginate every list with a default and a maximum, returning `total`, `limit`, `offset` | A1 (default 10, max 100), A2 | Documents, versions, comments, search results |
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
