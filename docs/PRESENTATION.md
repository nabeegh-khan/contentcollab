# Presentation plan: Wednesday 2 December 2026, 1:15pm

What we show, what we say and what we answer, built from the course rubric. Status was checked on 11 November 2026 (about 10:50, Toronto) against `main` at `7d3e60b`, the project board, the open pull requests and the live cluster (read-only `kubectl` and `curl` on `https://contentcollab.app`). The status columns are re-checked on Fri 20 November and Tue 24 November; anything marked "not started" or "in a PR" here is not claimed in the presentation until it works on the cluster.

## 1. What is scored

Peer reviewers score only what is shown and said in the presentation and the Q&A, not the code. The criteria and points are those of the course rubric as given to the team; the handout itself is not in this repository.

| Criterion | Points | What earns it |
|---|---|---|
| Clarity and Communication | 6 | A listener who has not read the repository can follow the problem, the architecture, each demo step and why it matters |
| Technical Progress and Demonstration | 10 | A live demo of the working system for the four checklist items below; recorded material as backup |
| Advanced Features and Completion Plan | 4 | Two advanced features presented with purpose, design and what is finished, plus a dated plan for the rest |

The technical checklist: a containerized multi-service app (Compose, Swarm or Kubernetes); stateful persistence (PostgreSQL and storage that survives restarts or redeploys); orchestration (deployment, service management, replication, scaling); monitoring and observability (metrics, logs, dashboards or alerts, with their purpose).

Slot length. The README timeline says "6 minutes plus Q&A, live demo required". The run order in section 3 is about 10 minutes and marks the steps that make a 6-minute cut. Confirm the real slot length before the 24 November slides.

## 2. Evidence table

Status key: **live** = works on the cluster today; **main** = merged but not running on the cluster; **PR** = in an open pull request; **none** = not started (no branch or pull request).

### 2.1 The four checklist items

| Item | What we show | Exact command or screen | Delivered by | Status today | Gap |
|---|---|---|---|---|---|
| Containerized multi-service app | Separate containers for api, worker, PostgreSQL and Redis (web to follow) on Compose locally; on Kubernetes today api, PostgreSQL, Redis and the Gateway, and the worker after the first CI rollout | `docker compose up --build`, then `docker compose ps` (worker, db and redis show `healthy`; the api service has no Compose health check yet, so it shows `Up`); on the cluster `kubectl -n contentcollab get pods,svc -o wide` | Compose stack #18 (merged); worker #58, #60 (merged); web #47 and PR #86 | **Compose: main** (api, worker, db, redis). **Cluster: live** for api (2 pods), postgres, redis, Gateway; **worker: none on the cluster** (the first CI rollout has not run); **web: PR** #86 (its image does not build yet) | Worker and current api image reach the cluster only through the first CI rollout (#54, #83); web has no working image |
| Stateful persistence | PostgreSQL on a block-storage volume survives deleting its pod; uploaded files survive in object storage | `kubectl -n contentcollab get pvc data-postgres-0`; row count before and after `kubectl -n contentcollab delete pod postgres-0` (command in 3, step 4) | StatefulSet and claim #35 (merged); restart test #68; schema #37 and PR #88; Spaces bucket #53; storage module PR #89 | **Volume: live** (`data-postgres-0` Bound, 5 Gi, `do-block-storage`, PostgreSQL 18.6). **Restart test on the cluster: not run.** **Tables: none** (`\dt` returns "Did not find any tables", 11 Nov). **Files: not verified** (the cluster Secret has Spaces key entries and the ConfigMap names the bucket `contentcollab`, but no upload has been run and there is no upload route) | There is nothing in the database to show surviving until the schema merges; no file storage yet |
| Orchestration | Deployment, Service, StatefulSet, replication, self-healing, autoscaling and a rolling update | `kubectl -n contentcollab get deploy,sts,hpa,pdb`; delete one api pod and watch it replaced; `kubectl -n contentcollab get hpa api -w` during the load test | Manifests #35; HPA and metrics-server #72; spread rule #78 (merged); load test #69; gated rollout #76 (merged) and #83 (PR) | **Replication, HPA, PDB: live** (api 2/2, `cpu: 9%/70%`, min 2, max 5, two nodes). **Autoscaling evidence:** 6 November run, 2 to 5 replicas. **Spread rule: main, not live** (the running Deployment shows no `topologySpreadConstraints`). **Rolling update from CI: never run** | Final load-test runs with the current script (#69); rollout-under-load run; the cluster still runs the 4 November image |
| Monitoring and observability | The API's metrics, its JSON request log, the provider's dashboard and alerts, and an error-rate check, each with its purpose | `kubectl -n contentcollab port-forward deploy/api 3000:3000` then `curl localhost:3000/metrics`; the cluster's Insights tab in the DigitalOcean control panel; `doctl monitoring alert list`; `kubectl -n contentcollab logs -l app=api --since=5m --tail=-1 --prefix \| node scripts/error-rate.mjs` | `/metrics` #57 (merged); alert script #62 (merged); JSON logs, bounded labels and the error-rate check in PR #102 (#55); decision D18 | **`/metrics`: live** (inside the pod; `/metrics` on the public URL returns 404 by design). **DigitalOcean Insights: live** (every DOKS cluster runs the metrics agent). **DigitalOcean alert policies: none exist** (`doctl monitoring alert list` is empty on 11 Nov). **JSON logs and the error-rate check: PR #102, not on the cluster** (the running image predates them). **No agent in the cluster:** it does not fit the nodes (D18) | Run `scripts/alerts.sh`; roll out PR #102; rehearse the error-rate demo (stop Redis) |

### 2.2 The three criteria

| Criterion | What we show | Exact command or screen | Delivered by | Status today | Gap |
|---|---|---|---|---|---|
| Clarity and Communication (6) | One architecture slide with the request path traced aloud; one sentence of purpose per demo step and per metric; the glossary-free wording the Q&A section uses | `docs/img/architecture.png` (components, solid traffic lines, dashed config and monitoring lines, the four advanced-feature badges); the slide says it is the target architecture, since web, worker, Spaces and the monitoring agent are not all running yet | Diagram merged; slides due Tue 24 Nov; rehearsals in PLAN stage 5 | Diagram **main**. Slides, speaker split, timing: **none** | No issue for slides, script and the two timed rehearsals (open one); slot length unconfirmed |
| Technical Progress and Demonstration (10) | The live run order in section 3, with a recorded clip behind each step that can fail | The numbered steps and the recordings R1 to R9 | Section 2.1 | Cluster and public HTTPS URL **live** (`/health` returns `{"status":"ok","postgres":"ok","redis":"ok"}`, certificate `contentcollab-tls` Ready). No product function beyond `/health`: no routes for sign-in, upload, share or comment exist on `main` | The largest gap: the API routes (#39 to #42, #45, #46) and the schema (#37) are not merged; no recording exists |
| Advanced Features and Completion Plan (4) | Two features in depth (section 4) and the dated plan for the rest | Slide: purpose, design, finished, not finished; slide: plan with dates | Section 4 | Auto-scaling and high availability: partly **live**. CI/CD: **main**, rollout never run. Security and real-time: **none** beyond HTTPS | First CI rollout; final load-test numbers |

## 3. Demo run order (about 10 minutes)

Written for the system as it should stand on 2 December. The "Needs" column says what each step needs and its status today. Times add to 10:00; the last column marks the 6-minute cut.

| # | Time | Say and show | Command or screen | Needs (status 11 Nov) | Fallback | 6-min cut |
|---|---|---|---|---|---|---|
| 1 | 0:00 | The problem and the target architecture: a place to share a document and review it together, traced from browser to Gateway to api to PostgreSQL, Redis and object storage | Architecture slide | Slide not made | None needed (slide) | yes, 0:40 |
| 2 | 1:00 | The live, containerized parts: HTTPS on the public URL, pods on two nodes, volume bound | Browser lock on `https://contentcollab.app/health`; `kubectl -n contentcollab get pods,svc,hpa,pvc -o wide` | Works today (`/health` ok, 2 api pods on different nodes, postgres, redis). Add the worker and web once deployed | **R1** | yes, 0:40 |
| 3 | 2:00 | The product: sign in, upload a PDF, share it, comment with a pin; a second browser shows the comment without a refresh. Nothing runs in the background during this step | Two browsers on `https://contentcollab.app` | None of it exists: auth #39, upload #40, shares #41, comments #42, live #45 and #46, web #47 to #49 | **R2**; decision on 20 Nov: if the routes are not merged, this step becomes a slide with the contract (`docs/API.md`) and the schema, and the 1:30 goes to steps 4 and 6 | no |
| 4 | 3:30 | Persistence: the row survives the database pod being deleted; the same volume re-attaches | `kubectl -n contentcollab exec postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from users"'`, then `kubectl -n contentcollab delete pod postgres-0`, `sleep 5`, `kubectl -n contentcollab wait --for=condition=ready pod/postgres-0 --timeout=120s` (the pause avoids "not found" before the StatefulSet recreates the pod), the same query, `kubectl -n contentcollab get pvc data-postgres-0`. No load runs during this step: `/health` pings PostgreSQL, so a deleted database pod makes every request a 503 | Schema merged (#88) and at least one row; restart test run once beforehand (#68) | **R3** | yes, 0:50 |
| 5 | 4:30 | Self-healing: delete an api pod, the ReplicaSet replaces it, the Service keeps answering | `kubectl -n contentcollab delete pod <one api pod>` with `kubectl -n contentcollab get pods -l app=api -w` beside `curl -s https://contentcollab.app/health` in a loop (no load test running; a deleted pod can fail a few requests, which is stated aloud) | Works today | **R4** | no |
| 6 | 5:15 | Autoscaling: CPU above 70% adds api replicas, two to five, within about 85 s of load | Terminal A, started at 5:15: `BASE=https://contentcollab.app STEPS=150 STEP_SECONDS=180 node scripts/loadtest.mjs`; terminal B: `kubectl -n contentcollab get hpa api -w`. The scale-up came within 85 s on 6 November, so the replica count is on screen by about 6:40; the load keeps running through step 7's start and is stopped before step 7's rollout run | Works today on the old image; final run with the current script and the spread rule live (#69). Node memory was 82% and 75% at idle on 11 November and the load test stops at 95%, so check headroom before the day | **R5** (full 3-minute run, played from the scale-up) | yes, 1:30 |
| 7 | 7:15 | Rolling update without dropped requests, and the pipeline that does it: checks, build, rollout, automatic undo | The last green `deploy` run in GitHub Actions; `kubectl -n contentcollab rollout status deployment/api`; `ROLLOUT=1 SKIP_HPA_CHECK=1 BASE=https://contentcollab.app STEPS=50 STEP_SECONDS=120 node scripts/loadtest.mjs` shows `0 failed` (the rollout run is too long to wait for live: the clip is played, the command shown) | CI token and `SMOKE_URL` set (#54, #76); first CI rollout run; rollout-under-load run (#69) | **R6** (the load run) and **R8** (the Actions run, including a forced failure that rolls back) | no |
| 8 | 8:00 | Monitoring: metrics, logs, the provider dashboard and alerts, and one error-rate check turning red, each with its purpose (latency and errors to see users' view; node CPU, memory and disk for capacity) | The Insights tab; `doctl monitoring alert list`; `kubectl -n contentcollab logs -l app=api --since=2m --tail=-1 --prefix \| node scripts/error-rate.mjs` before and after `kubectl -n contentcollab scale deploy/redis --replicas=0` (steps in `docs/DEMO_OBSERVABILITY.md`) | `scripts/alerts.sh` run; PR #102 rolled out; the Redis stop rehearsed (the site is down while it is scaled to zero; scale it back at once) | **R7** | yes, 1:00 |
| 9 | 9:15 | The two advanced features, what is finished, and the dated plan | Slides from section 4 | Slides not made | None needed (slide) | yes, 0:40 |

The 6-minute cut (steps 1, 2, 4, 6, 8, 9) is 5:20 and leaves 40 seconds of slack. In the cut the load test starts at the beginning of step 6 and step 6 is played from the scale-up point of R5 if the live scale-up is slow.

Shell. The commands are written for Git Bash (set `MSYS_NO_PATHCONV=1` before any path argument). In PowerShell 5.1 they need changes: environment variables as `$env:BASE='https://contentcollab.app'; $env:STEPS='150'; $env:STEP_SECONDS='180'; node scripts/loadtest.mjs`, `curl.exe` in place of `curl`, and the quoted `psql` command prints nothing, so run it from Git Bash. Rehearse in the shell used on the day.

### Recorded fallbacks

Recorded material is the backup, not the plan. None exists yet. Each clip is made on the final cluster after the 21 November freeze and replaced if the system changes; the same files are kept on the presenting laptop and in a shared folder.

| Clip | Covers | Record when | Status |
|---|---|---|---|
| R1 | Step 2: public URL, pods, volume, nodes | After the first CI rollout puts the worker and web on the cluster | not recorded |
| R2 | Step 3: sign-in to live comment in two browsers | After the API and web pull requests merge | not recorded; depends on #39 to #42, #45 to #49 |
| R3 | Step 4: row, pod deleted, row still there, claim unchanged | After #88 merges and #68 passes | not recorded |
| R4 | Step 5: pod deleted and replaced | Any time | not recorded |
| R5 | Step 6: 180 s load step, HPA 2 to 5, replicas per step | After #69's final run | not recorded |
| R6 | Step 7: rollout restart under load, zero failed | After #69's rollout run | not recorded |
| R7 | Step 8: Insights tab, the alert policies, the error-rate check going from ok to ALERT and back | After PR #102 is rolled out and `scripts/alerts.sh` has run | not recorded |
| R8 | Step 7: pull request checks, merge, rollout, and a forced failure rolled back | After the first CI rollout. `deploy.yml` runs only on a push to `main`, so a forced failure is rehearsed on a throwaway cluster or after adding a manual trigger to the workflow; never by pushing a broken change to `main` | not recorded |
| R9 | Whole-cluster failure: the stack on the presenting laptop with `docker compose up --build`, `docker compose ps`, `curl localhost:3000/health` | After the final Compose file (web added) | not recorded; the Compose stack runs api, worker, db and redis today (the api shows `Up`, not `healthy`) |

If the cluster is down on the day, the plan in the proposal applies: switch to the laptop's Compose stack (R9) and say so.

## 4. Advanced features and completion plan

The handout asks for at least two advanced features. We present the two the cloud slice owns, because both already have working parts on `main` and neither waits on the API critical path.

### 4.1 Auto-scaling and high availability

**Purpose.** Keep the API answering when load rises or a pod or node is lost, and show it happening.

**Design.** A HorizontalPodAutoscaler on average CPU at 70%, two to five api replicas (`k8s/base/api.yaml`); two worker nodes; a PodDisruptionBudget with `minAvailable: 1`; rolling updates with `maxUnavailable: 0` and `maxSurge: 1`; a readiness probe on `/health` (Postgres and Redis) and a liveness probe on the socket only; a topology spread constraint on `kubernetes.io/hostname` so replicas land on both nodes (ARCHITECTURE D5); metrics-server installed by `scripts/metrics-server.sh` because DigitalOcean serves no resource metrics until it is (BUILD_LOG, 6 Nov); a load test that refuses to run while the HPA cannot read CPU.

**Finished.** Everything above is in `main`; not all of it runs on the cluster. Live: the HPA, PDB, probes, metrics-server, two api pods on different nodes. Evidence: on 6 November the HPA went from 2 to 3 replicas at 17:08:58, to 4 at 17:09:13 and to 5 at 17:09:43 under a 150 req/s step; at 250 req/s CPU was still 78% of target at five replicas; with five pods one node reached 93% memory, so on two 2 GB nodes memory, not CPU, is the limit (BUILD_LOG). Those tables measure the rate sent, not served (`docs/loadtest/README.md`).

**Not finished.** The spread rule is not on the running Deployment (the cluster runs the 4 November image); the final measurements with the current script (#69); the rolling update under load; the node-loss behaviour has not been exercised.

### 4.2 CI/CD

**Purpose.** A merge to `main` becomes a tested, pinned, reversible deployment, so the grader can reproduce what runs.

**Design.** On every pull request: lint, format, typecheck, Jest and Supertest against a PostgreSQL service container, manifest validation with kubeconform, and a build-and-smoke of the api image (`ci.yml`, jobs `api`, `test`, `k8s`, `worker`, `scripts`, `docker`). On merge to `main` for `api/`, `worker/`, `k8s/` or the workflow: the same checks, then build and push both images to GHCR tagged with the commit, then a rollout job that gets a 600-second kubeconfig from `doctl`, pins both Deployments to the commit, applies once, undoes any Deployment whose rollout does not turn ready, and checks `/health` when `SMOKE_URL` is set (`deploy.yml`, #76).

**Finished.** Pull-request checks run on every pull request to `main`. The deploy workflow is merged; its last three runs (11 November) built and pushed both images and stopped before the rollout, as written when no token exists.

**Not finished.** The rollout has never run: the repository has no `DIGITALOCEAN_ACCESS_TOKEN` secret and no `SMOKE_URL` variable, so the cluster still runs the 4 November image and has no worker. The pinning tests (#83) are still in review. The migration Job before rollout is not wired (#88 review).

### 4.3 Dated completion plan for the rest

Features not presented as finished, with what can be shown by the final deadline (Saturday 5 December, with the presentation on 2 December). Cloud-slice dates are the plan; dates for other slices are set on their issues (14 November agenda, item 1) and are not entered here.

| Date | What | Issue or PR |
|---|---|---|
| Thu 12 Nov | First CI rollout: set the `DIGITALOCEAN_ACCESS_TOKEN` secret and the `SMOKE_URL` variable, merge #83 after its review window | #54, #76, #83 |
| Sat 14 Nov | Checkpoint: worker and current api image on the cluster; `scripts/alerts.sh` run; PR #102 (JSON logs, error-rate check) rolled out | #54, #55, #62 |
| Mon 16 to Thu 19 Nov | Restart test on the cluster once the schema is in; final load-test runs (stepped and rollout under load); first recordings R3 to R6 | #68, #69 |
| Fri 20 Nov | Integration checkpoint and demo dry run. Decision: step 3 is live or a slide | README timeline, PLAN integration strategy |
| Sat 21 Nov | Feature freeze: no new features; only fixes to what the demo shows | README timeline |
| Sun 22 to Tue 24 Nov | Re-record any clip whose system changed (R1, R2, R7, R8); introduction Mon 23 Nov; slides Tue 24 Nov; two timed rehearsals | PLAN stage 5 |
| Mon 30 Nov to Tue 1 Dec | No deploys except fixes; run `scripts/smoke.sh` and a full rehearsal on the cluster; confirm DNS, certificate and node headroom | `scripts/smoke.sh` |
| Wed 2 Dec | Presentation, 1:15pm. Morning: `BASE=https://contentcollab.app bash scripts/smoke.sh` (it skips the `/metrics` check for a deployed URL; set `METRICS_BASE` to a port-forward to include it) | |
| Sat 5 Dec | Final deliverable: report, video, deployment left running | README timeline |

Security, real-time, sharing by link, tags and search, email and backup are shown as finished only if merged and working on the cluster by Fri 20 November; otherwise the slide says "planned" and shows the contract and the schema that exist. Backup (#50) and email (#44) are stretch goals and are not claimed.

## 5. Questions and answers

Each answer is taken from the repository. Where the feature is not built, the answer says so. Sources: ARCH = `docs/ARCHITECTURE.md`, LOG = `docs/BUILD_LOG.md`, PRAC = `docs/PRACTICES.md`, PROP = the proposal, API = `docs/API.md`.

### 5.1 State

1. **Where does the data live?** PostgreSQL runs as a StatefulSet on a 5 Gi DigitalOcean block-storage claim; files go to Spaces object storage (ARCH D2). The claim `data-postgres-0` is Bound on the cluster today.
2. **What happens if the database pod dies?** The StatefulSet recreates it and the same claim re-attaches (`k8s/base/postgres.yaml`). The test on minikube is done (#52); the test on the cluster is #68 and has not run.
3. **Why not a managed database?** The course does not count a managed database alone as persistent storage (PRAC DB-2). Running it in the cluster on a volume is the required pattern (ARCH D2).
4. **Why are files not on the volume?** A file written to one pod's disk is invisible to the other replicas and a volume attaches to one node (ARCH D2). Spaces is reachable from every replica.
5. **Is there database failover?** No: one replica, because the volume attaches to one node at a time (RESEARCH, PROP 2.3 "No database failover"). The mitigation is a nightly `pg_dump` to Spaces (#50), which is not built.
6. **Are there backups today?** No. A volume is not a backup (PRAC DB-3); the CronJob and restore runbook are #50, a stretch goal, not started.
7. **What state do the api pods hold?** None; every request is answered from PostgreSQL, Redis or Spaces, so any pod can be killed or added (ARCH, failure handling). Redis holds socket state, counters and the job queue (PRAC DB-8, RESEARCH).
8. **Does Redis survive a restart?** No volume is attached; the manifest says it holds nothing that cannot be rebuilt (`k8s/base/redis.yaml`). Queued jobs are in Redis, so they do not survive the pod being replaced.
9. **How are two simultaneous edits handled?** Documents and comments carry a row version; a write based on an older row is rejected with 409 (PROP 2.4, #37 checklist). The columns exist in the migration in PR #88; the routes that use them are not built.
10. **How is a retried upload kept from duplicating?** `document_versions.checksum` is unique per document, and the same checksum is `409` (API, #37 checklist). Schema in PR #88; upload route (#40) not built.
11. **How does the schema change over time?** Versioned migrations run by a Compose service on start and by a Kubernetes Job before each rollout (#37, PRAC CON-5). The runner is in PR #88; the Job is not wired into the deploy yet.
12. **What is in the database right now?** Nothing: PostgreSQL 18.6 is running and `\dt` shows no tables on 11 November. The schema is PR #88; a contract test for it is in draft PR #95 and is not yet part of CI.

### 5.2 Scaling

1. **What scales?** The api, by a HorizontalPodAutoscaler on average CPU at 70%, two to five replicas (`k8s/base/api.yaml`). PostgreSQL does not scale (RESEARCH).
2. **What is the evidence?** On 6 November the HPA went from 2 to 5 replicas within 85 s of a 150 req/s step (LOG). Final runs with the current script are #69.
3. **Why does it stop at five?** Five is the HPA maximum; at 250 req/s CPU was still 78% of target there (LOG). On two 2 GB nodes memory reached 93% first.
4. **Is CPU the limit?** On this cluster memory is: with five pods one node hit 89% to 93% (LOG, 6 Nov). The memory guard in the load test stops the run at 95%.
5. **How does the HPA read CPU?** From metrics-server, installed by `scripts/metrics-server.sh` at chart 3.14.0; before that the HPA showed `<unknown>/70%` and could not scale (LOG, 6 Nov).
6. **Can you add nodes?** The node pool can grow by one if the autoscaling demo runs out of room (LOG, 4 Nov). No node autoscaler is configured.
7. **How do WebSockets work across replicas?** Sticky sessions at the Gateway plus the Socket.IO Redis adapter, with WebSocket-only as the fallback (ARCH D12). The server and client are not built (#45, #46).
8. **Do replicas spread across both nodes?** The manifest has a spread constraint on hostname with `maxSkew: 1` (#78, merged). The running Deployment predates it; both pods are on different nodes today by scheduling, not by rule.
9. **Does the worker scale?** One replica with concurrency 2; those are starting values "with no measurement behind them" (LOG, 7 Nov). It is not on the cluster yet.
10. **Do uploads limit scaling?** Uploads stream to Spaces and are never held whole in memory (ARCH D9, D10). A review of the storage module (PR #89) flagged that its default buffers up to four 5 MiB parts per upload against the 256 Mi pod limit; that is arithmetic from the library's defaults, not a measurement.
11. **What does the load test measure?** Stepped requests per second against `/health` (which pings PostgreSQL and Redis), with p50 and p95 of successes, failures with reasons, node memory and ready replicas per step (`scripts/loadtest.mjs`, `docs/loadtest/README.md`).
12. **What are the caveats on the numbers?** The 6 November tables report the rate sent, not served, and count only 5xx as errors; the final report uses runs with the current script (`docs/loadtest/README.md`, LOG 10 Nov). In the second run 30 requests (0.12%) failed with socket closes, all in the step where the HPA added three pods (LOG, 6 Nov).

### 5.3 Failure

1. **What if an api pod is killed?** The ReplicaSet replaces it and the Service stops routing to it until it is ready (PRAC INF-8, INF-11); a PodDisruptionBudget keeps at least one available during node drains and upgrades (it does not govern a pod that is deleted or crashes). Step 5 of the demo shows it.
2. **What if the database pod is killed?** It restarts on the same volume; the readiness probe fails meanwhile, so the api pods leave the Service (PROP 2.4). The cluster test is #68.
3. **What if a node is lost?** There are two nodes and a soft spread rule (`ScheduleAnyway`), so at two replicas replacement pods can schedule on the survivor (ARCH D5; by the requests on 11 November, about 384 Mi more would land on one node). At four or five replicas that does not hold, and we have not exercised a node loss.
4. **What if a bad version is deployed?** The rollout job waits for `rollout status` (180 s) and runs `rollout undo` if it fails; a failed `/health` smoke check undoes both Deployments (`deploy.yml`, #76). It has never run against the cluster because the token is not set.
5. **What if Redis is down?** The readiness probe asks Redis, so pods leave the Service until it returns. On `main` since #75 the api starts and answers `/health` within 500 ms with a 503, and picks Redis up again without a restart (LOG, 10 Nov). That is not on the cluster until the first rollout: the running image waits for Redis before it listens. The "serve and fall back to polling" behaviour in ARCH is a design, not built.
6. **What if PostgreSQL is down?** `/health` returns 503 and the readiness probe stops traffic to that pod; liveness checks only the socket, so a dependency outage does not restart the container (`k8s/base/api.yaml`, PRAC INF-11).
7. **Does a rolling update drop requests?** Settings are `maxUnavailable: 0`, `maxSurge: 1`, a 30 s grace period and a SIGTERM handler that stops accepting and finishes in-flight requests (`api.yaml`, `server.ts`). The measurement is the `ROLLOUT=1` load run (#69), not yet recorded.
8. **What if a worker dies mid-job?** The job stays in Redis for the next worker (RESEARCH). Jobs are meant to be idempotent; the only job today is a ping.
9. **What if Redis restarts?** Queued jobs are lost with it, since it has no volume (`redis.yaml`). Socket state is rebuilt when clients reconnect.
10. **What if the cluster fails during the presentation?** We switch to the Compose stack on the presenting laptop (PROP section 3, risks; clip R9).
11. **What if a deploy runs twice or out of order?** One rollout runs at a time and `cancel-in-progress` is false, so a merge waits for the running one (`deploy.yml`). GitHub does not guarantee the order of waiting runs, which the file says.
12. **How is a failure found afterwards?** The JSON request log (`kubectl logs`: one line per request with its request ID, route template and status), `/metrics`, and `scripts/error-rate.mjs` for the 5xx share per route (ARCH D16, D18; PR #102, not yet rolled out; the running image still writes plain text).

### 5.4 Monitoring

1. **What do you measure?** `/metrics` exports `http_requests_total`, `http_request_duration_seconds`, an errors counter and the Node.js process defaults (`api/src/lib/metrics.ts`). Connected sockets and upload bytes are not exported yet (ARCH D6).
2. **Where do the metrics go?** Nowhere beyond the pod: `/metrics` is read live through a port-forward, and DigitalOcean's own metrics agent feeds the Insights tab and the alert policies. No agent of ours runs in the cluster because it does not fit (ARCH D18).
3. **Is `/metrics` public?** No. The Gateway routes only `/api`, `/socket.io` and `/health`; `/metrics` on the public URL returns 404 (checked 11 Nov), and `scripts/smoke.sh` reads it through a port-forward.
4. **What alerts exist?** DigitalOcean policies for node CPU, memory and disk above 80% for five minutes, emailed (`scripts/alerts.sh`); none are created on the cluster yet. The error rate is a script, `scripts/error-rate.mjs`, not an alert that sends a message (ARCH D18).
5. **Why neither Datadog nor Prometheus and Grafana in the cluster?** Measured on 11 November: with the API at its five-pod maximum, 405 MiB of memory is unrequested and about 172 MiB is unused across the two nodes. The Datadog agents request 768 MiB; a Prometheus and Grafana pair is estimated at 192 to 384 MiB of requests (no official figure) against about 172 MiB unused (ARCH D18).
6. **What does monitoring cost in resources?** Nothing in the cluster: the provider's agent already runs on every node and the scripts run on a laptop. A third node for the Datadog agent would cost about US$0.03 an hour with tax (COST_PLAN, ARCH D18).
7. **What logs do you keep?** One JSON line per request from every api pod, with its request ID, route template and status, kept as long as the pod's own log (`kubectl logs`); no log store outside the cluster (ARCH D16, D18; PR #102, not yet rolled out).
8. **How do you know autoscaling worked?** `kubectl get hpa -w`, plus the load test's per-step ready replicas and its scaling CSV (HPA desired, pods created and ready every 2 s) in `docs/loadtest/`.
9. **What does `/health` report?** `{"status":"ok","postgres":"ok","redis":"ok"}` with 200, or a 503 naming the dependency that is down (API, `api/src/routes/health.ts`).
10. **What is `smoke.sh` for?** The curl checks before every demo: `/health` with both dependencies ok, `/metrics` through a port-forward, and an unknown route returning the API's 404 shape (`scripts/README.md`).
11. **What is the dashboard?** The cluster's Insights tab in the DigitalOcean control panel: CPU, load, memory, disk and disk I/O for the cluster and each node, from the metrics agent every DOKS cluster runs. Application numbers come from `/metrics` and the request log, not from a dashboard; there is no pod-level graph (ARCH D18).
12. **Is the deployment itself monitored?** After each rollout the workflow checks `/health` and undoes the rollout on failure, once `SMOKE_URL` is set (not set yet); the run page in GitHub Actions is the record.

### 5.5 Security

1. **How are passwords stored?** bcrypt hashes, at least 8 characters (API, PROP 2.7). The column exists in PR #88; sign-in (#39) is not built.
2. **How is a request authenticated?** A JWT in the `Authorization` header that expires after 24 hours, with no refresh (API, PRAC SEC-4). Not built.
3. **How are roles enforced?** One middleware loads the caller's share row before any handler runs; no row returns 404, not 403, so a document's existence is not leaked (API). Not built (#39, #41).
4. **How do share links work?** A random token with an expiry, and the role check runs on every request (PRAC SEC-9). `link_token` (unique) and `expires_at` are in PR #88; the routes are #41.
5. **Is traffic encrypted?** TLS terminates at the Gateway with a Let's Encrypt certificate from cert-manager; `contentcollab-tls` is Ready (checked 11 Nov). Port 80 is also served: `http://contentcollab.app/health` returns 200 with no redirect, so "force HTTPS" (PRAC SEC-5) is not yet true.
6. **Where are secrets kept?** In one Kubernetes Secret created by hand from `secrets.example.yaml`, git-ignored, injected as environment variables; the repository holds only `.env.example` (ARCH D5, PRAC SEC-1). File-mounted secrets are preferred by SEC-2 and not used yet.
7. **Is a Kubernetes Secret encrypted?** No, it is base64: anyone with cluster access can read it (PRAC SEC-10), so the cluster credentials stay with the cluster owner.
8. **How does CI reach the cluster?** A `DIGITALOCEAN_ACCESS_TOKEN` repository secret and a kubeconfig that expires after 600 seconds; it is the first secret to revoke if it leaks (ARCH D13). The secret is not set yet.
9. **Are the database and Redis reachable from outside?** No: Postgres is a headless ClusterIP Service and Redis a ClusterIP Service, and only the Gateway has an external address (live, `kubectl get svc`; PRAC SEC-8).
10. **Do containers run as root?** The api and worker pods run as user 1000 with `runAsNonRoot` (`k8s/base/api.yaml`, PRAC SEC-6). The PostgreSQL, Redis and Gateway containers use their image defaults.
11. **How is input limited?** JSON bodies are capped at 1 MB today (`api/src/server.ts`). Validation of every body, a 50 MB upload cap, allowed file types and a per-user write rate limit are in the contract (API) and not built.
12. **Do the logs leak tokens?** No headers, cookies, query strings or bodies are logged, the route is the template, and a rejected body is not quoted; tests check each (ARCH D16, PR #102, not yet rolled out).

### 5.6 Cost

1. **What does it cost a month?** About US$54 (prices checked 4 November): two US$18 nodes, a US$12 load balancer, US$5 for Spaces and under US$1 for the 5 Gi volume; the control plane is free (LOG, 4 Nov, from DigitalOcean's pricing pages).
2. **Who pays?** One account hosts the cluster and the cost is split four ways (PLAN, risks).
3. **Is there credit?** No. The student pack's DigitalOcean credit ended on 31 July 2026, so the budget assumes paid usage (ARCH, open questions; the source is a third-party report checked 16 September, not a DigitalOcean or GitHub page).
4. **Why two nodes?** One node is cheaper but gives no node-level redundancy; larger nodes cost more than the load test needs (LOG, 4 Nov).
5. **Why not the cheaper Swarm option?** Two US$6 droplets would cost less, but Swarm has no autoscaler and ties the database volume to one node by hand; those two points decided it (ARCH D1).
6. **Why not the high-availability control plane?** It costs US$40 a month and is not needed (RESEARCH).
7. **How do you stop paying?** `scripts/cluster-down.sh` deletes the cluster, its load balancer and volumes after grading; the deployment stays up through grading (PRAC INF-7, PLAN stage 6).
8. **What does an extra replica cost?** No extra money, because pods share the two nodes; the cost is memory headroom, where the fifth pod pushed a node to 89% to 93% (LOG).
9. **What does monitoring cost?** DigitalOcean metrics and alerts are free. The Datadog files are kept in the repository but no agent is installed, so nothing is billed or requested for monitoring (ARCH D18).
10. **How fast can it be rebuilt?** The cluster was created in 7 min 38 s by `scripts/cluster-up.sh` (LOG, 4 Nov). A rebuilt cluster gets a new load balancer address, a DNS change and a new certificate (ARCH D13).
11. **Why DigitalOcean and not Fly.io?** One provider, one set of operations; Fly.io's Kubernetes service is a paid beta the course does not recommend (ARCH D1).
12. **What did the domain cost?** `contentcollab.app` was registered on 17 October through the student pack, first year free (ARCH D5). Actual spend to date is not recorded in the repository (see the gaps list).

## 6. Gaps, ordered by points at risk

Highest risk first. "Points" names the criterion and its maximum.

| # | Gap | Points at risk | Issue |
|---|---|---|---|
| 1 | No schema on the cluster, so the persistence demo has nothing to show surviving; the schema pull request has blocking review comments and is ten days past its 1 November date | Technical Progress (10) | #37, PR #88 (review posted 11 Nov) |
| 2 | No product function: the API has `/health` and `/metrics` only; sign-in, documents, shares, comments and live events have no API route pull request (PR #89 is the storage module; PRs #91 and #93 are web pages); the web image does not build | Technical Progress (10), Advanced Features (4) | #39 to #42, #45, #46; #47 to #49, PRs #86, #91, #93 |
| 3 | The CI rollout has never run: no `DIGITALOCEAN_ACCESS_TOKEN` secret, no `SMOKE_URL` variable; the cluster runs the 4 November image, has no worker, and lacks the spread rule | Technical Progress (10), Advanced Features (4) | #54, #76, PR #83 |
| 4 | Monitoring is not live: PR #102 is not rolled out, no DigitalOcean alert policies exist, and the error-rate demo (stop Redis) is not rehearsed; there is no in-cluster dashboard (the provider's Insights tab is the dashboard, ARCH D18) | Technical Progress (10) | #55, PR #102 |
| 5 | Restart test on the cluster not run | Technical Progress (10) | #68 |
| 6 | Final autoscaling and rollout-under-load measurements missing; the 6 November tables measure the rate sent | Technical Progress (10), Advanced Features (4) | #69 |
| 7 | No recorded fallback for any step | Technical Progress (10) | open an issue: record R1 to R9 |
| 8 | No slides, speaker split or timed rehearsal; slot length unconfirmed (6 minutes in the README, about 10 in this plan) | Clarity and Communication (6) | open an issue: slides, script, two rehearsals; confirm slot |
| 9 | File storage not verified: the cluster Secret has Spaces key entries and the ConfigMap names the bucket, but no upload has run; the storage module (PR #89) is unverified against the real Space (region, checksums) | Technical Progress (10) | #53, #40, PR #89 |
| 10 | Node memory headroom: 405 MiB unrequested and about 172 MiB unused with the API at five pods (11 Nov, `node scripts/memory-headroom.mjs`); no monitoring agent is installed for that reason (ARCH D18). The 6 November load run reached 93% node memory and the load test stops at 95%; re-measure after the rebuild | Technical Progress (10) | #69; ARCH D18 |
| 11 | Real-time and security (sign-in, roles, links) are committed features with no code, so they can only be shown as planned | Advanced Features (4) | #39, #41, #45, #46 |
| 12 | Port 80 serves the API without a redirect, so "force HTTPS" is not true as the Q&A would have to say it | Technical Progress (10), minor | open an issue: redirect or remove the claim |
| 13 | cert-manager 1.19 reached end of life on 8 July 2026, and Kubernetes 1.37 is one minor version above cert-manager 1.21's supported range; the upgrade script is in draft PR #94 and has not been run live | Risk on the day | #54, PR #94 |
| 14 | Spend to date is not recorded; a cost question has no number | Clarity (6), minor | open an issue: read the billing page before 2 December |
| 15 | Backup and restore (stretch) not started; do not claim it | Advanced Features (4), minor | #50 |
| 16 | The first CI rollout is also the first worker deployment and the first run of the pinned rollout on the real cluster; none of it has been rehearsed | Technical Progress (10) | #54, #76, PR #83 |
| 17 | The Compose api service has no health check and request logs are plain text, so two practices the Q&A cites (PRAC CON-4, OBS-1) are only partly true | Technical Progress (10), minor | open an issue |
| 18 | The demo commands are written for Git Bash and fail or print nothing in PowerShell 5.1 | Technical Progress (10) | note in section 3; rehearse in the shell used on the day |

## Method

Everything above was read from `main` at `7d3e60b` or observed on 11 November 2026: `kubectl get`/`describe`/`top` and one `exec` for the table list and the `/metrics` read, `curl` against `https://contentcollab.app` (including `/metrics`, and `http://` without redirect), `doctl monitoring alert list`, `gh` for issues, pull requests, runs, repository secret and variable names, and the board. Nothing was changed on the cluster.
