# ContentCollab study guide for the Q&A

Written 22 November 2026 from `main` at 0add334 and the live cluster as checked that day. It is meant to be read aloud or listened to: short sentences, one idea at a time. When a fact is unfinished or untested, the guide says so, and the best thing to do in Q&A is to say so too. Where a claim rests on a file, the file or decision (D-number in `docs/ARCHITECTURE.md`) is named so it can be opened and checked.

How to answer any question, from the course's own guidance: give the direct answer first, then the reason or evidence, then the trade-off. Two sentences is enough to start.

---

## 1. The app in 60 seconds

ContentCollab is a place where a remote team reviews a document together. You upload a PDF, an image or an office file. You share it with a person and a role, or through a link that expires. Every upload is a new version. People comment on a version, reply in threads, and mention each other. Comments show up live for everyone who has that version open.

It is a review tool, not a live editor like Google Docs. Live co-editing needs a different kind of engine (CRDT or operational transform), so we chose versions and comments instead (D3).

The cloud problem behind it is three things. A comment must reach a person whose browser is connected to a different server than yours. The data must survive a server restart. And the service must stay up when a server dies or the load grows.

It runs on DigitalOcean Kubernetes in the New York region (nyc3) at `https://contentcollab.app`. The four team members are Nabeegh Khan, Milton Wang, Jyotiraditya Kale and Yiqing (Eyrika) Liu.

Roles on a document are Owner, Editor, Commenter and Viewer. Allowed file types are PDF, PNG, JPEG, DOCX, XLSX, PPTX, TXT and Markdown, up to 50 MiB (`api/src/lib/parseUpload.ts`).

---

## 2. One request, end to end

Follow four actions. All of them enter through the same front door.

**The front door.** The browser connects to a DigitalOcean load balancer. Behind it is the Gateway: NGINX Gateway Fabric, which implements the Kubernetes Gateway API. It ends HTTPS using a certificate that cert-manager gets from Let's Encrypt. It sends `/api`, `/socket.io` and `/health` to the API, `/grafana` to Grafana (route on `main` since #162, live since the Grafana rollout of 23 November), and everything else to the web pods (`k8s/doks/gateway.yaml`). It also allows uploads up to 50 MiB, because its default limit is 1 MiB (D29).

**Sign in.** The browser loads the web app from the web pods: a React app built with Vite, served by NGINX. The user types an email and password. The browser sends them to `POST /api/v1/auth/login`. One of the two API pods answers. It compares the password with a bcrypt hash stored in PostgreSQL (bcrypt with cost 12), and returns a signed token that is valid for 24 hours (`api/src/routes/auth.ts`). The browser keeps the token and sends it on every later call. Because the token is signed, any API pod can check it. No pod keeps a session in memory, so it does not matter which pod answers.

**List documents.** `GET /api/v1/documents` goes through the Gateway to an API pod. The pod checks the token, then asks PostgreSQL for the documents this user owns or has been shared. PostgreSQL runs as a single pod with a 5 GiB volume attached. The API returns a page of results with a cursor for "load more".

**Upload.** The browser sends the file to `POST /api/v1/documents` (a new document) or to `/documents/:id/versions` (a new version). The API checks the role: only an Owner or Editor may add a version. It reads the upload as a stream, refuses a type that is not on the list, and computes a SHA-256 hash of the bytes. If the same hash is already a version of that document, it answers 409 "File Already Uploaded". Otherwise the file goes to DigitalOcean Spaces (object storage, S3-compatible), and a row for the new version goes into PostgreSQL. Two people uploading at once are handled with row locks and unique constraints in the database, not with a version check on every write.

**Comment, live.** Each browser also holds a Socket.IO connection to the API and has joined a "room" for the version it is looking at. When user A posts a comment, the browser sends `POST` to the API. The pod that receives it checks the role (Commenter or higher), writes the comment to PostgreSQL, and emits a `comment:created` event to that version's room. A different pod may hold user B's connection. The Socket.IO Redis adapter publishes the event through Redis, so every API pod passes it to its own connected browsers (`api/src/lib/realtime.ts`, `api/src/lib/socket.ts`, D4, D12). User B sees the comment without refreshing.

**What the worker does.** A separate pod runs a BullMQ worker, which reads jobs from a queue in Redis. It has three job types: a ping, a version diff, and a summary (D10, D21, D22). The worker is running and health-checked, but nothing in the API enqueues these jobs yet: the compare route is a stub behind a feature flag that is off, and the summary uses a stub provider unless a Claude one is configured. Say so if asked: the diff and summary code exist and are unit-tested, but they are not wired into a user path.

**Where state lives.** Metadata and comments: PostgreSQL on the volume. Files: Spaces. Live events: passing through Redis, not stored. API, web and worker pods: no state, which is why they can be killed and replaced freely.

---

## 3. Every component

For each: what it is, why we chose it, what it costs, how it fails and recovers. Prices are what our own cost plan recorded (`docs/COST_PLAN.md`, section 9). They are plan figures from 11 November and not a current invoice, so say "about" and "per our plan".

### The cluster (DigitalOcean Kubernetes)

What: managed Kubernetes. Control plane run by DigitalOcean without high availability, region nyc3. One node pool of `s-2vcpu-4gb` machines that can scale from one to two nodes. On 22 November both nodes were running. Kubernetes 1.37.

Why: we chose Kubernetes over Docker Swarm because the autoscaler and volume handling decided it. Kubernetes scales on CPU and re-attaches the database volume when a pod moves. On Swarm the volume ties the service to one node (D1).

Cost: about US$2.56 a day with two nodes and about US$1.59 with one, including the load balancer and the volume (COST_PLAN section 9). Spaces is about US$5 a month. The region is nyc3 because Toronto (tor1) returned "insufficient capacity" for every size we tried (D13). High availability for the control plane was turned off in a rebuild on 11 November, because it was costing about US$1.61 a day and the course does not need it.

Failure: a node can die. The scheduler moves its pods to the other node and the database volume follows. We drained a node on 20 November and the marker row survived all 4 events including the drain (`docs/evidence/2026-11-20-restart-test-drain.txt`). With two nodes, a second failure takes the service down. That is a known limit.

### Gateway (NGINX Gateway Fabric)

What: the front door described above. Runs as the `contentcollab-nginx` Deployment, one pod.

Why: `ingress-nginx` was retired in March 2026 and gets no more security fixes. The Gateway API is the supported replacement (D11). We bumped Gateway Fabric to v2.9.0 on 20 November (#142).

Cost: no extra charge beyond the load balancer, about US$15 a month.

Failure: it is one pod, so it is a single point of failure for traffic. If it dies Kubernetes restarts it. We have not made it highly available. Say that plainly.

### Web (React, Vite, NGINX)

What: two pods serving the built React app. Hash-based routes, a sign-in page, a documents page, a document view with versions and comments, and an operations page at `#/ops`.

Why: the proposal made the web client small on purpose, so the time could go to the cloud parts (D8, D27).

Cost: tiny. Each pod asks for 10 millicores of CPU and 32 MiB of memory.

Failure: two pods, rolling updates, so a deploy does not take the page down. The web image runs as the unprivileged nginx user on port 8080 (PR #164, merged 22 November, deploy succeeded; D27). Checked live on 23 November: `id -u` in the running web pod prints 101 and both web pods are Running (`docs/evidence/2026-11-23-cloud-test.txt`).

Not built: rendering a PDF or an image inside the page, search, tags and delete on the documents page, and drawing comment pins on the page. Pins are stored with each comment but not drawn.

### API (Node.js, Express, TypeScript)

What: two to five pods. It handles sign-in, documents, versions, shares, links, comments, the operations snapshot and the restart drill, and the Socket.IO server. It also exposes `/health` and `/metrics`.

Why: one codebase and one language for API and worker. Each route checks a role through one middleware before any work is done (`api/src/middleware/requireRole.ts`).

Cost: each pod asks for 100 millicores and 128 MiB, with limits of 500 millicores and 256 MiB. On 22 November each pod was using about 10 millicores and 145 MiB.

Failure and scaling: the Horizontal Pod Autoscaler keeps 2 to 5 pods, aiming for 70% average CPU of the requested 100 millicores. A PodDisruptionBudget keeps at least one pod available when something is drained. Rolling updates use `maxUnavailable: 0` and `maxSurge: 1`, so every old pod stays until a new one passes its readiness check, and a 10-second `preStop` pause lets the load balancer stop sending traffic to a pod that is about to stop (D14). If PostgreSQL's connection drops, the API logs it and reconnects instead of crashing (D26).

### Worker (BullMQ)

What: one pod running a queue consumer with a small health endpoint. Jobs are version diff, summaries and a ping.

Cost: asks for 128 MiB and 100 millicores, limit 512 MiB.

Failure: one pod. No API path enqueues jobs yet, so do not oversell it; it is not on the demo path.

### Redis

What: one pod running Redis 8. Two jobs: the Socket.IO adapter's publish and subscribe channel, and the BullMQ queue.

Why: it is the standard way to share live events across API replicas (D4).

Failure: it is a single pod and has no persistence configured here. If it restarts, live connections reconnect and queued jobs in flight can be lost. Comments are not lost, because they are written to PostgreSQL first. `/health` reports Redis as "ok" or not.

### PostgreSQL

What: PostgreSQL 18 as a StatefulSet with one replica and a 5 GiB DigitalOcean block-storage volume (`do-block-storage`). It holds users, documents, versions, shares, links and comments.

Why in the cluster and not a managed database: the course does not count a managed database alone as persistent storage in this design, so we run it ourselves on a volume (D2). The price of that choice is that backups are ours to build.

Cost: the volume is about US$0.02 a day.

Failure and recovery: delete the pod and the new one re-attaches the same volume. Tested on 19 November (3 of 3) and 20 November with a node drain (4 of 4): a marker row survived every time (`docs/evidence/2026-11-19-restart-test.txt`, D15). The test does not show recovery from losing the volume itself. Deleting the volume claim, the namespace or the cluster deletes the data, unless the volume's reclaim policy is set to Retain. A script, `scripts/pv-retain.sh`, does that, and issue #104 is about running it on the live cluster. Check #104's state before saying it is done.

Migrations: a Kubernetes Job runs the database migrations before each rollout, and a check in CI makes sure migrations expand first and contract a release later, so old and new pods can run together (D20, D24).

### Spaces (object storage)

What: DigitalOcean's S3-compatible storage for uploaded files and for database backups. The API reaches it through the AWS SDK (`api/src/lib/storage.ts`).

Cost: about US$5 a month in the plan.

Failure: managed by DigitalOcean. If Spaces is unreachable, uploads fail with an error while the rest of the app works.

### Backups

What: a CronJob, `db-backup`, runs `pg_dump` every night at 03:00 Toronto time and writes the dump to Spaces (D30). A runbook and a restore script describe how to bring a dump back. PR #147 is merged (23 November) and deployed. The CronJob ran on its own at 03:00 Toronto on 22 and 23 November, and on 23 November a job started by hand from it wrote `backups/contentcollab-20261123T224507Z.dump` (29,362 bytes) to Spaces (`docs/evidence/2026-11-23-backup-live.txt`).

What was proven: one restore into a scratch database (`docs/evidence/2026-11-21-backup-restore.txt`, on the PR's branch until it merges).

What was not: a restore into the live cluster, and the Spaces lifecycle rule and a separate bucket and key for backups. The gap in data is up to a day.

### Monitoring: Prometheus, Grafana, and the operations page

What: Prometheus scrapes the API pods and the Kubernetes node metrics (8 of 8 targets up on 22 November). kube-state-metrics reports pod and autoscaler state. Grafana shows request rate, share of 5xx errors, p95 latency, autoscaler replicas and node memory. The operations page in our own web app shows pods, nodes, events, per-pod CPU and memory charts for 15 minutes, and a comment count. It reads live data from the Kubernetes API, Prometheus and PostgreSQL through `GET /api/v1/ops`, only for admin users (D31).

Why: we first planned Datadog. The agent did not fit the memory of the original small nodes, and the course teaches Prometheus and Grafana (D18, D19; D17 was superseded).

Cost: Prometheus asks for 192 MiB. Its data sits on an emptyDir, so a restart loses history.

Grafana's route: PR #162 added a `/grafana` route and a link from the operations panel, and is on `main`. The Grafana rollout was done on 23 November: `/grafana/` answers through the Gateway (login page 200, health ok) and the operations snapshot carries the link (`docs/evidence/2026-11-23-cloud-test.txt`). The browser sign-in with a saved login is still to be done by hand; until then say the route answers, not that the demo dashboard was opened in a browser. DigitalOcean also has three alert policies on the account (CPU, memory and disk above 80% for 5 minutes). Their firing and e-mail delivery were not tested. There is no Alertmanager.

### The restart drill

The operations page has a button that asks Kubernetes to evict one pod. The PodDisruptionBudget lets it happen only while a second API pod is ready, so the page keeps serving. It is admin only, limited to one per minute, and limited to an API pod or the database pod. The demo uses the API pod. Before 22 November it had not been clicked in a browser. A check was planned for 24 November. If it has not passed by the talk, say it plainly.

### CI/CD

What: GitHub Actions. Every pull request runs lint, type checks, API, worker and web tests, the Docker builds, Kubernetes manifest checks (rendered with kubectl and validated with kubeconform at two Kubernetes versions), migration checks and the monitoring checks (`.github/workflows/ci.yml`). On every merge to `main` the deploy workflow runs the same checks, builds the three images tagged with the commit hash, pushes them to GitHub's container registry, pins the Deployments to that hash, applies the manifests and waits for each rollout. If a rollout does not become ready, or `/health` does not answer, it undoes only what that run changed (D25). A push that changes only Markdown does not deploy.

Why: so what runs in the cluster is always a known commit that passed the checks.

Limit: this stops a bad release. It is not a canary or a blue-green deploy.

---

## 4. Who built what (from the Git history)

This is read from `git log` and `gh pr list` on 22 and 23 November. Commit counts are a rough measure and many of Nabeegh's are docs and logs, so read the work by pull request.

**Nabeegh Khan:** the cluster and everything around it. The Compose skeleton, Kubernetes manifests, GitHub Actions CI and deploy, cluster bring-up and tear-down scripts, the autoscaling and rolling-update tuning and load tests, the restart test for PostgreSQL, the migration Job and migration checks, the observability stack (Prometheus, Grafana, kube-state-metrics), JSON request logs and metrics, DigitalOcean alerts, the Gateway upload limit, the worker (skeleton, version diff, summaries), the operations page and the restart drill, the web client's comments, versions panel, documents page and share form, the cross-replica check, the nightly backup (PR #147, merged 23 November), and the Grafana route. Also the engineering docs.

**Eyrika (Yiqing) Liu:** the access layer of the API. Auth with register, login and the role middleware (#111), shares by user and by link with expiry (#114), and documents and versions (#116). Proposal section 1.

**Jyotiraditya Kale:** the data and live layer. The database schema and first migration (#88), the Spaces storage module (#89), the Socket.IO server with the Redis adapter (#136), threaded comments and mentions (#135), and the revert-from migration (#137). Proposal section 4.

**Milton Wang:** the web skeleton served by NGINX (#86), the contract review on the API document (#85), the project introduction (#134 and #163), and proposal text. Owner on the board of the PDF and image view (#49), which is not built. His document viewer (#91) and sign-in and document list (#93) pull requests are open and unmerged; his first backup attempt (#143) was closed and the backup was rebuilt by Nabeegh (#147).

When a question is about a part someone else built, you can still answer from the design: the decision records name the design and the reason. Do not claim to have written the code you did not write.

---

## 5. The course's Q&A topics

Each has a direct answer first, then the evidence.

**Containerization.** Each of api, web and worker has its own Dockerfile and Compose runs the full stack locally. The web image is multi-stage; api and worker are single-stage and run as the non-root `node` user. Evidence: `api/Dockerfile`, `compose.yaml`, D7, D10, D27. Checked live on 23 November: the web pods run as uid 101 (`docs/evidence/2026-11-23-cloud-test.txt`).

**PostgreSQL and persistent storage.** PostgreSQL runs as a StatefulSet on a 5 GiB DigitalOcean volume, and files are in Spaces. A deleted pod, a restarted API, a database scaled to zero and back, and a drained node all left the data intact. Evidence: `docs/evidence/2026-11-19-restart-test.txt`, `2026-11-20-restart-test-drain.txt`, D15. Trade-off: it does not prove recovery from losing the volume; nightly dumps to Spaces help, and a live restore is not rehearsed.

**Orchestration.** Kubernetes keeps two API and two web pods running, spreads the API pods across nodes (a spread rule exists for the API only), scales the API from 2 to 5 on CPU, and replaces a failed pod. On 21 November a load run took the API from 2 to 5 pods, with 0 failed requests at 50 requests a second and 16 of about 27,000 (0.06%) at 150 a second. Evidence: `docs/evidence/2026-11-21-hpa-watch.txt`, `docs/loadtest/2026-11-21T19-12-52-177Z.csv`, D14. Trade-off: the load was against `/health` from one laptop, so it is a floor, not a real-traffic test.

**Monitoring and observability.** Prometheus, Grafana and our own operations page show request rate, errors, p95 latency, pod and autoscaler state, and per-pod CPU and memory. Evidence: `docs/evidence/2026-11-22-cluster-check.txt`, D19, D31. Trade-off: Prometheus history is lost on restart, there is no Alertmanager, and the Grafana link depends on the manual rollout step.

**Advanced features.** Four are built: security (hashed passwords, signed tokens, roles, HTTPS, secrets), CI/CD, real-time with Redis, and autoscaling with high availability. Evidence: D5, `docs/ROADMAP_2026-11-22.md`. They fit together: CI/CD ships the pods that the autoscaler scales, and Redis is what lets scaled pods share live events. Email on share and mention was a stretch goal and is not started.

**Completion plan.** Open items and owners are in `docs/ROADMAP_2026-11-22.md`. The final deliverable is due Saturday 5 December, 11:59 pm.

---

## 6. Fifteen likely follow-ups

1. **Why Kubernetes and not Docker Swarm?** The autoscaler and volume re-attachment. The price is more objects to get wrong, so we tested manifests on minikube first (D1).
2. **Why Gateway API and not an Ingress?** ingress-nginx was retired in March 2026 (D11). The Gateway API is newer, so there is one more controller to run.
3. **Why run PostgreSQL in the cluster?** A managed database alone does not count as persistent storage for this course (D2). We own the backups.
4. **What survives a restart, and what does not?** Rows and files survive a pod, node or API restart. They do not survive deleting the volume claim or the cluster unless the reclaim policy is Retain (D15, issue #104).
5. **How does a comment reach someone on another pod?** The Socket.IO Redis adapter publishes the event through Redis, and every pod relays it to its own clients (D4, D12). We checked it with `scripts/cross-replica.mjs` over a direct port-forward. The one run through the Gateway failed on how attribution was counted, not on delivery.
6. **How do roles work?** One middleware reads the share row for the user and document and allows or refuses before the handler runs (`requireRole.ts`). An insufficient role returns 403, and a user with no share on the document gets 404.
7. **How are passwords and sessions handled?** bcrypt cost 12, a signed token valid for 24 hours, and the secret lives in a Kubernetes Secret (a template of placeholders is in Git).
8. **What happens when two people upload the same file?** The second gets 409 because the SHA-256 hash matches an existing version. A different file becomes the next version.
9. **How do rolling updates avoid downtime?** `maxUnavailable: 0`, a readiness probe and a 10-second preStop pause (D14). Inside the cluster a restart under 50 requests a second dropped none (0 of 4,501). Through the public address a restart lost 28 of about 6,000, so we claim fewer drops, not none (D14). Separately, in the 21 November scale-up 16 of about 27,000 failed as pods were added.
10. **What happens if a node dies?** Pods move to the other node and the volume follows (drain test, 20 November). With two nodes, a second failure takes the service down.
11. **How do migrations avoid breaking a rollout?** A Job runs them first. They add before they remove, so old and new pods can run together, and CI fails on an unmarked drop or rename (D20, D24).
12. **What does CI/CD protect against?** A change that fails a check never reaches the cluster, images are pinned to the commit, and a failed rollout is undone (D25). It is not a canary.
13. **Why Prometheus and Grafana, not Datadog?** The agent did not fit the small nodes. The cost is that we run and size Prometheus ourselves (D18, D19; D17 was superseded).
14. **What is untested or unfinished?** A signed-in click-through of the operations page and restart drill before the talk (planned 24 November), a restore into the live database, the Grafana rollout check, PDF and image rendering, comment pins, search, tags, email on share, and a second Gateway pod.
15. **What would you cut first?** Pins and email on share. They are additive and off the demo path, and the review workflow works without them (D5, proposal "criteria for cutting").

---

## 7. Known limits and the plan to 5 December

Known limits, in plain words:

- Two nodes only. A node drain works; two failures do not.
- Single pods for the Gateway, Redis, PostgreSQL and the worker. No automatic failover for the database.
- The backup has not been restored into the live database (a restore ran once into a scratch database on 21 November), and the dumps have no retention rule yet (the Spaces lifecycle rule is still to do).
- No PDF or image rendering in the page, no comment pins drawn, no search, tags or delete on the documents page, no email on share or mention. Other users' comments show as "Member" and a short id.
- The load test used `/health` from one laptop.
- The architecture picture `docs/img/architecture.svg` was redrawn on 23 November from `main` (a one-slide version is `docs/img/architecture-slide.svg`).
- Alerts exist at DigitalOcean but firing and e-mail delivery were not tested.

The plan, by date (from `docs/ROADMAP_2026-11-22.md`):

- Tue 24 November: check the operations page and restart drill on the cluster, and submit the slides.
- Wed 2 December, 1:15 pm: the presentation. The Q&A is about two minutes.
- Sat 28 November: full rehearsal with the live demo.
- Before 2 December: repeat the load run on the final image.
- Sat 5 December: the README report (at most 5000 words), a 2 to 5 minute video, the deployment left running.

---

## 8. One-page glossary

- **Pod.** One running copy of a program in Kubernetes.
- **Deployment.** Keeps a chosen number of identical pods running and replaces failed ones.
- **StatefulSet.** Like a Deployment for programs that need their own stable storage, here PostgreSQL.
- **Volume / PersistentVolumeClaim.** A disk a pod asks for. It outlives the pod.
- **HPA (Horizontal Pod Autoscaler).** Adds or removes pods based on CPU use. Ours: 2 to 5 pods at 70%.
- **PDB (PodDisruptionBudget).** A rule that keeps a minimum number of pods up when something is drained.
- **Rolling update.** Replace pods one at a time, keeping old ones until new ones are ready.
- **Readiness probe.** A health check that decides whether a pod receives traffic.
- **preStop hook.** A short pause before a pod stops, so traffic drains away first.
- **Node.** A machine in the cluster. Ours: two DigitalOcean droplets with 2 vCPU and 4 GB.
- **Drain.** Move all pods off a node, as before maintenance.
- **Gateway API.** The Kubernetes way to route outside traffic in. It replaces Ingress.
- **NGINX Gateway Fabric.** The program that carries out the Gateway rules for us.
- **cert-manager / Let's Encrypt.** Gets and renews the HTTPS certificate.
- **Spaces.** DigitalOcean's S3-style object storage, for uploads and backups.
- **Socket.IO.** A library for live two-way messages between browser and server.
- **Redis adapter.** Lets several Socket.IO servers share events through Redis.
- **BullMQ.** A job queue that stores its jobs in Redis. The worker reads it.
- **CronJob.** A Kubernetes job that runs on a schedule. Ours: nightly backup.
- **pg_dump.** PostgreSQL's tool that writes the database out as a file.
- **Migration.** A versioned change to the database structure.
- **Expand then contract.** Add new columns first, remove old ones a release later, so two versions can run together.
- **Prometheus / Grafana.** The first collects numbers over time; the second draws them.
- **kube-state-metrics.** Reports the state of Kubernetes objects to Prometheus.
- **p95.** The time that 95% of requests finish within.
- **GHCR.** GitHub's container registry, where our images live.
- **JWT.** A signed token that proves who you are. Ours lasts 24 hours.
- **bcrypt.** A slow, salted password hashing method.
- **Role.** What you may do on one document: Owner, Editor, Commenter or Viewer.
- **D-number.** A numbered design decision in `docs/ARCHITECTURE.md`, with the options it beat and its source.
