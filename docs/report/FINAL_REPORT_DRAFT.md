# ContentCollab: final report draft (22 November 2026, updated 23 November)

Draft of the `README.md` the course asks for by Sat 5 Dec (handout: `docs/COURSE_PRESENTATION_REQUIREMENTS.md`, section "Final deliverable"). Maximum 5000 words in the submitted file; the body of this draft (Team Information to Lessons Learned) is 2,760 words on 23 November, leaving room for screenshots' captions and the teammates' sections. Everything below comes from the repository record (README, `docs/ARCHITECTURE.md` decisions D1 to D31, `docs/BUILD_LOG.md`, `docs/evidence/`, merged pull requests, `ai-session.md`). `[TODO: owner]` marks a part that needs that person's own words, a screenshot or a fact only they have. Claims are written as of 23 November and must be re-checked against the deployed system before 5 December. When this draft moves into `README.md`, delete this paragraph and the final section.

## Team Information

| Name | Student number | Email | GitHub |
|------|----------------|-------|--------|
| Milton Wang | 1009114192 | milt.wang@mail.utoronto.ca | @MWang-max |
| Jyotiraditya Kale | 1013397370 | jyotiraditya.kale@mail.utoronto.ca | @Jyotiraditya7 |
| Yiqing (Eyrika) Liu | 1008052580 | eyrika.liu@mail.utoronto.ca | @Oct31yrika |
| Nabeegh Khan | 1001388152 | nabeegh.khan@mail.utoronto.ca | @nabeegh-khan |

(From the current `README.md`. `[TODO: each member]` confirm the email is the preferred, active one.)

## Motivation

`[TODO: Eyrika, from proposal section 1 (PR #66)]` Reviewing a document with remote colleagues usually means attachments in email threads, where comments and versions drift apart. ContentCollab keeps one document, its versions and the discussion about a specific version in one place. The cloud problem is what makes it a course project: comments must reach everyone looking at that version, including people connected to different servers; data must survive a restart; and the service must stay up when a server dies or load grows (`docs/ARCHITECTURE.md` D4, D10, D14).

## Objectives

From the proposal and `docs/ARCHITECTURE.md` D5:

1. A review workflow: upload a document as a version, share it with a role, comment, mention, and see comments live (D3, D4).
2. A stateful, containerized, multi-service application on Kubernetes with PostgreSQL on persistent storage and files in object storage (D1, D2).
3. Four advanced features, each demonstrated: security, CI/CD, real-time, and auto-scaling with high availability (D5).
4. Monitoring that shows what the system is doing (D19, D31).
5. Evidence that it works as intended, kept in `docs/evidence/`.

Out of scope on purpose: live text editing and track changes (D3).

## Technical Stack

![Components and their connections: browser, Gateway, web, api, worker, Redis, PostgreSQL, Spaces, monitoring and CI/CD](docs/img/architecture.png)

Solid arrows carry traffic and data; dashed arrows are deploys, certificates and monitoring. Source: [docs/img/architecture.svg](docs/img/architecture.svg).

| Layer | Choice |
|-------|--------|
| Orchestration | **Kubernetes** on DigitalOcean (DOKS 1.37, two worker nodes), chosen over Docker Swarm for the autoscaler and for volume handling (D1). One Kustomize base with `minikube` and `doks` overlays (`k8s/`) |
| API | Node.js, TypeScript, Express, Socket.IO, in Docker (`api/`) |
| Web client | React, built to static files and served by its own container (`web/`, D8, D27) |
| Worker | Node.js on a Redis queue (BullMQ): version comparison, summaries behind one provider interface (`worker/`, D21, D22) |
| Data | PostgreSQL as a StatefulSet on a 5 GiB DigitalOcean block-storage volume (D2); Redis for Socket.IO across replicas (D4, D12) |
| Files | DigitalOcean Spaces, S3-compatible (D2) |
| Traffic | Gateway API with NGINX Gateway Fabric and cert-manager, HTTPS on `contentcollab.app` (D11) |
| Scaling | HorizontalPodAutoscaler, 2 to 5 API pods at 70% CPU; PodDisruptionBudget; rolling updates with no unavailable pods (D14) |
| CI/CD | GitHub Actions: checks on every pull request; on merge, images tagged with the commit SHA, applied once, rolled back if the rollout fails (D25, `docs/evidence/ci-cd.md`) |
| Monitoring | Prometheus, kube-state-metrics, Grafana in the `observability` namespace (D19); `/metrics` and JSON request logs on the API (D16); an operations page in the web client (D31); DigitalOcean metrics |
| Local development | Docker Compose (D7) |
| Backup | Nightly `pg_dump` CronJob to Spaces and a restore runbook (D30; PR #147, merged 23 November; the CronJob ran on its own at 03:00 Toronto on 22 and 23 November and a job started by hand wrote a dump to Spaces: `docs/evidence/2026-11-23-backup-live.txt`; a restore into a scratch database: `docs/evidence/2026-11-21-backup-restore.txt`) |

## Features

Core features (proposal 2.6), state on `main` at 23 November (`docs/ROADMAP_2026-11-22.md` has the pull request and owner for each):

- **Sign-in and roles.** Registration and login with bcrypt-hashed passwords and signed tokens; four roles (Owner, Editor, Commenter, Viewer) enforced by middleware before each action (PR #111).
- **Documents and versions.** A documents page that lists and uploads (PR #165, 22 November), upload as a new version, download, version list; revert in the API (PR #116, web versions panel #154). An identical file is refused with 409.
- **Sharing.** By user and by link with an expiry (PR #114); the share form in the web client is merged (PR #146, 22 November): through the share route the form calls (API, no browser), a document shared as viewer shows in the other account's list, a viewer's comment is refused (403), and after the role is raised to commenter it is accepted (`docs/evidence/2026-11-23-cloud-test.txt`, step 6); the form itself has not been screenshotted on the live site yet.
- **Comments.** Threads, replies, resolve and @-mentions, live for everyone on the version (PRs #135, #136, #144; D28). Pins are stored but not drawn.
- **Operations page.** For an admin: pods and containers by node, the autoscaler, nodes, storage, traffic, CPU and memory charts from Prometheus, recent events, and a restart drill for an API pod or the database pod, one a minute, admin only (D31; PRs #150, #151, #157, #158, #160). A link to Grafana at `/grafana/` (PR #162, merged 22 November, live since the observability rollout of 23 November: the login page answers through the Gateway, `docs/evidence/2026-11-23-cloud-test.txt`, step 5). The restart drill was run on the live cluster on 23 November through the route the page calls: the database pod was replaced, the document and a comment survived, and the site answered again after 13 s on the second run (the first run's first answer came at 62 s, cause not proven).

Core course requirements and where each is shown:

| Requirement | How the project meets it | Evidence |
|---|---|---|
| Containerized multi-service application | api, web, worker, PostgreSQL and Redis run as containers on Kubernetes; the web image runs as the unprivileged nginx user (uid 101, PR #164, merged 22 November) | `exec deploy/web -- id -u` printed 101 on the live cluster, 23 November (`docs/evidence/2026-11-23-cloud-test.txt`); D27 |
| PostgreSQL and persistent storage | PostgreSQL 18 as a StatefulSet on a 5 GiB block-storage volume; files in Spaces; nightly dump to Spaces | restart tests 19 and 20 November (`docs/evidence/2026-11-19-restart-test.txt`, `2026-11-20-restart-test-drain.txt`); the database-pod drill of 23 November; D2, D15, D30 |
| Orchestration | Deployments with a HorizontalPodAutoscaler, a PodDisruptionBudget, rolling updates and a Gateway; replicas spread over two nodes | D1, D11, D14; `docs/evidence/2026-11-21-hpa-watch.txt` |
| Monitoring and observability | Prometheus, kube-state-metrics and Grafana; the operations page in the web client; `/metrics` and JSON request logs; DigitalOcean alert policies (CPU, memory, disk above 80%; applied, e-mail delivery untested) | D19, D31; `docs/evidence/2026-11-22-do-alerts.txt`; the 23 November ops snapshot (8 containers, 2 nodes, no source in error) |

Advanced features, how they meet the course requirements:

| Feature | What it is | How it fits | Evidence |
|---|---|---|---|
| Security | bcrypt, signed tokens, role checks, expiring share links, HTTPS at the Gateway, keys in Kubernetes Secrets, 50 MiB upload cap at the Gateway | Every route checks the signed-in user and role; nothing sensitive is in an image or the repository | PRs #111, #114, #145, #98; D29 |
| CI/CD | Tests gate the build; images pinned to the commit; migrations run as a Job before each rollout; a failed rollout is undone, only what that run changed | The deployed version is always known, and a bad release does not stay | D20, D24, D25; `docs/evidence/ci-cd.md` |
| Real-time | Socket.IO with a Redis adapter, so an event on one API pod reaches a viewer on another | The reason the API is stateless and can be scaled | D4, D12, D28; `scripts/cross-replica.mjs`; two passing runs against both API pods over a port-forward (`docs/evidence/2026-11-21T21-10-54-663Z-cross-replica.txt`, `...21-11-45-889Z-...`); the one run through the Gateway failed on counting, not on delivery (`...21-07-24-161Z-...`) |
| Auto-scaling and high availability | HPA 2 to 5, pods spread over both nodes, rolling updates with `maxUnavailable: 0`, preStop drain | Scaling out needs stateless pods, shared events and a database that survives pod loss | D14; `docs/evidence/2026-11-21-hpa-watch.txt`: 2 to 5 pods, 0 failures at 50 req/s, 16 failures (0.06%) at 150 req/s within one second as the pod set changed |

Stretch: backup and recovery (PR #147, merged and running, see the stack table; the proposal named Milton as owner, the work was done by Nabeegh after the first attempt, #143, was closed); email on share and mention (issue #44, not started).

## User Guide

`[TODO: Milton for sign-in and documents pages, Nabeegh for the operations page and versions; screenshots from the deployed site, in docs/img/, with alt text]`

1. **Register and sign in** at https://contentcollab.app/. `[TODO: screenshot of the sign-in page; docs/evidence/2026-11-21-ui2-signin-1920x1080.png exists]`
2. **Open a document.** After sign-in the Documents page lists the documents you can read, with your role and the time of the last change, and an Open link to the latest version; Load more shows the next 20. The same page uploads a new document (a file and an optional title; PDF, PNG, JPEG, Word, Excel, PowerPoint, text and Markdown, up to 50 MiB). The list was checked on the deployed site for both demo accounts on 22 November (`docs/evidence/2026-11-22-documents-list.txt`). Not built: search, tags and delete on this page, and a version number in the list (D28; PR #165). `[TODO: screenshot of the Documents page]`
3. **Upload a new version.** Choose a file in the versions panel; the list shows the version and a download link. `[TODO: screenshot]`
4. **Comment and mention.** Type a comment with `@Name`; everyone viewing the version sees it with no refresh, and the person mentioned gets a notice. `[TODO: screenshot of two windows; docs/evidence/2026-11-21-ui2-document-1920x1080.png exists]`
5. **Share.** On the Documents page, the "Share" button on a document you own fills the form's document id; enter the other person's email, choose viewer, commenter or editor, and press Share. The page answers "Shared with <email> as <role>." The person sees the document in their own list with that role. `[TODO: Nabeegh, screenshot of the form]`
6. **Operations page** (admin only), `#/ops`: read the cards; "Open Grafana for the details" opens Grafana; "Restart an API pod" or "Restart the database pod" asks for confirmation, then Recent events shows the drill entry and the readiness warnings, the pod's start time changes, and the stored comments stay the same. The page says the database restart takes about 30 seconds; measured on 23 November: 13 s on the second run, and the first run's first answer at 62 s. `[TODO: Nabeegh, screenshots before, during, after, from the 24 Nov check, in docs/evidence/]`

## Development Guide

- **Prerequisites:** Docker with Compose, Node.js 24, `kubectl` and minikube for the manifests. Versions as the Dockerfiles and CI use them (read 22 November): Node 24 for the api, worker and web build, PostgreSQL 18, Redis 8; `kubectl` and minikube are not pinned by the repository, so any current release.
- **Environment:** copy `.env.example` to `.env`; it lists every variable; `.env` is never committed.
- **Database and storage:** `docker compose up --build` starts the API, web, worker, PostgreSQL and Redis; migrations run before the API starts. Files go to Spaces in the cluster; locally `[TODO: Jyotiraditya, how local file storage works with PR #89]`.
- **Tests:** API tests need PostgreSQL and Redis (`compose.test.yaml`); `npm test` in `api/` and `worker/`; `npm test` in `web/`; manifest checks with `python3 -m unittest tests.test_k8s_deploy tests.test_k8s_status_rbac tests.test_deploy_undo tests.test_gateway_body_size tests.test_grafana_route tests.test_backup_cronjob -v`; `node --test scripts/*.test.mjs` and `node --test k8s/observability/*.test.mjs`. Each package also runs `npm run lint`, `npm run format:check` and `npm run typecheck` (api, worker; web has lint and format). These are the commands of the CI jobs in `.github/workflows/ci.yml`; CI runs them on every pull request. `[TODO: Nabeegh, run the list once on a clean clone before 5 Dec]`
- **Cluster:** `scripts/cluster-up.sh`, `scripts/observability-up.sh`, `scripts/smoke.sh`; `kubectl apply -k k8s/minikube` for a local cluster (`k8s/README.md`).
- **Credentials:** `[TODO: Nabeegh, after sending them: "Credentials sent to TA", with the date. Handout: password-protected archive to the TA by email, password in a separate email, both by the deadline.]`

## Deployment Information

Live URL: https://contentcollab.app/ (health: https://contentcollab.app/health). Cluster `contentcollab` on DigitalOcean, region NYC3, two nodes, left running through grading (cost plan: `docs/COST_PLAN.md`). State on 23 November: 2 API, 2 web, 1 worker, PostgreSQL, Redis and the Gateway pod on two nodes, HPA 2 to 5 (`docs/evidence/2026-11-23-cloud-test.txt`); Prometheus 8 of 8 targets up on 22 November (`docs/evidence/2026-11-22-cluster-check.txt`). Grafana is at https://contentcollab.app/grafana/ (sign-in required). `[TODO: Nabeegh, confirm the cluster region and node size on 4 Dec]` The Spaces bucket is in TOR1 and the cluster is in NYC3 (D2, `docs/BUILD_LOG.md`).

## Video Demo

`[TODO: team: the 2 to 5 minute video URL, in our own voices. Plan: the 75-second path of the live demo plus the restart test and the pipeline, recorded on the deployed site. Nabeegh records the operations segment after the 24 Nov check.]`

## AI Assistance & Verification

Where AI meaningfully contributed: reading current documentation and weighing options for the architecture (the Gateway API instead of the retired ingress-nginx, D11), drafting Kubernetes manifests, CI steps and tests, and reviewing pull requests before merge (`ai-session.md` has dated examples).

One representative limitation (`ai-session.md`, "The autoscaler that could not read CPU"): the proposed metrics-server install and load-test guard were checked against the live cluster (`cpu: <unknown>`) and an independent review found that a Helm flag in it was deprecated, that `bash` in PowerShell is WSL and not Git Bash, and that any `kubectl` failure let the load test carry on. We fixed all three, with the failing test written first.

How correctness was verified: tests written before the change and seen failing (for example the Gateway namespace fault: a CI check failed on the fault alone, then passed with the fix, `ai-session.md` "Gateway namespace fault"); an independent read of each change; live checks on the cluster kept as files in `docs/evidence/` (restart tests, autoscaling run, cross-replica check); versions, flags and prices taken from the official source with the date in `docs/BUILD_LOG.md`. `[TODO: each member, one sentence on their own use of AI tools, so the section speaks for all four]`

## Individual Contributions

From merged pull requests and the issue board on 23 November (`git shortlog` counts differ and are not the measure: the handout assesses substance). Each member writes the final wording `[TODO: each member]`.

- **Nabeegh Khan:** cloud orchestration and operations: the DigitalOcean cluster and its bring-up scripts, Kubernetes manifests and overlays, the Gateway and TLS, autoscaling and rolling-update work with load tests, CI/CD and its rollback, observability (Prometheus, Grafana, `/metrics`, request logs), the operations page and restart drill, backup CronJob, the web client's comments and versions panel and the share form, the worker, the test harness, and the architecture, build log and practices documents. 62 merged pull requests on 23 November, including #62, #72, #83, #99, #102, #103, #118, #123, #125, #140, #144, #145, #146, #147, #148, #150, #151, #153, #154, #156, #157, #158, #159, #160, #162, #164, #165 and #166 (#152 and #155 were closed and replaced by #157 and #158).
- **Eyrika Liu** (`@Oct31yrika`): API: authentication and roles (#111), shares by user and link (#114), documents and versions (#116); proposal section 1 (#66). Open follow-ups #129, #130, email on share and mention #44. `[TODO: Eyrika to check and add reviews and design work]`
- **Jyotiraditya Kale** (`@Jyotiraditya7`): database schema and first migration (#88), Spaces storage module (#89), threaded comments and mentions (#135), the Socket.IO server with the Redis adapter (#136), the reverted-from migration (#137), proposal section 4 draft (#33). Client hook for live events #46 and review decisions #24 open. `[TODO: Jyotiraditya to check and add]`
- **Milton Wang** (`@MWang-max`): the React skeleton served by Nginx (#86), the API contract review (#85), proposal section 3 draft (#34), the project introduction (#134), the presentation deck; sign-in and document list (#93) and document view (#49, #91) are open. `[TODO: Milton to check and add]`

## Lessons Learned and Concluding Remarks

Drawn from the record; `[TODO: team, in our own words]`:

- Spreading API pods across two small nodes and tuning memory limits, pod spread and the drain took several attempts before a rollout and a load step dropped almost nothing (D14, `docs/BUILD_LOG.md`); the remaining 16 failures show "reduced" and not "none".
- Monitoring changed course: the Datadog agent did not fit the first nodes (D17, D18), and the Lecture 10 stack fit after the node rebuild (D19).
- A merge can silently break a test: a missing `});` left one test inside another (BUILD_LOG, 22 November); the format check stopped CI before the test run, which is why each fault now gets a check that fails first.
- A web client that depends on one teammate's pull request is a schedule risk; the minimal client (D27) let the demo not depend on it.
- Known gaps at 23 November: no PDF or image rendering in the web client; no search, tags or delete on the documents page; pins stored but not drawn; comments by other users show as "Member xxxxxxxx"; the restart drill was run through the API on the live site but not yet clicked in a browser; email on share and mention not started.

## Repository layout (for the submitted README)

Keep the layout section of the current `README.md`; it matches the repository.

---

## Notes for the editor (delete before submitting)

Mismatches between the current `README.md` and the record, to fix when this moves in:

1. Word budget: the README must stay at or under 5000 words with screenshots as images; run `wc -w README.md` before submitting. The current README is about 1,340 words.
2. `ai-session.md` currently has many entries from one member; the handout asks for 2 to 4 representative ones per team, so choose entries that show judgment and verification, and add one from each other member who used AI.
3. The architecture figure in "Technical Stack" uses the path `docs/img/architecture.png`, which is right for the root `README.md` and not for this file in `docs/report/`; the redrawn figure (23 November) matches `main`, so keep it when this moves in.
