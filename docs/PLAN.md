# Project plan and responsibilities

Draft for proposal section 3 ("Project plan and team responsibilities", 15%). Individual Contribution is 15% of the final grade and is read from Git history, so every member owns a slice that shows up as their own commits, Issues and pull requests. Owners are **proposed** until the team meeting confirms them.

## Principle

The demo path (sign in, upload, share, comment, live update, restart test, scale-out, monitoring) depends on two people's slices only. Every other slice is additive: if it is late, the demo still runs and the feature is shown as planned work. No slice waits on another slice once the skeleton exists.

## Stages

Building starts now; the proposal is written from the architecture, not the other way round.

| Stage | Dates | Done when |
|---|---|---|
| 0. Architecture and proposal | 17 Oct to 7 Nov | ARCHITECTURE.md agreed; API contract in `docs/API.md`; proposal submitted 7 Nov; team formation on Quercus by 24 Oct |
| 1. Skeleton | 19 Oct to 1 Nov | `compose.yaml` with api, postgres, redis runs locally; schema and first migration; health endpoint; CI runs lint and tests on a PR; manifests run on minikube |
| 2. Core features | 26 Oct to 15 Nov | auth and roles; upload to Spaces with versions; share by user and link; comments; the minimal browser client |
| 3. Cloud | 2 to 15 Nov | DOKS cluster with Ingress and TLS; PostgreSQL on a PVC with the restart test passed; HPA and probes; DO alerts; CI deploys on merge |
| 4. Real-time and additive features | 9 to 22 Nov | Socket.IO with Redis adapter; tags, search, export; backups; notifications; health check quiz submitted 16 Nov |
| 5. Presentation | 23 to 24 Nov | project introduction 23 Nov; slides 24 Nov; live demo rehearsed twice on the presenting laptop |
| 6. Final | 25 Nov to 5 Dec | second presentation slot if assigned 2 Dec; README report, `ai-session.md`, video; deployment left running through grading |

Assignment 3 (31 Oct) and Assignment 4 (21 Nov) land inside stages 1 and 4; the plan leaves those weeks lighter.

## Division of work (proposed)

| Slice | Owner | What lands in Git under their name |
|---|---|---|
| Architecture, plan, Kubernetes, CI/CD, monitoring, auto-scaling, real-time | Nabeegh | `docs/`, `k8s/` manifests, cluster setup scripts, GitHub Actions workflows, `/metrics`, alert policies, Socket.IO server and Redis adapter, deployment and monitoring sections of the README |
| API and data: schema, migrations, auth and roles, documents, versions, upload to Spaces, comments | Milton | schema and migrations, auth routes and role middleware, document and comment routes with tests, the minimal browser client for the demo path |
| Tags, search and metadata export; email notifications on share and mention | member 3 | tag and search routes, CSV and JSON export, email integration, their tests |
| Backup and recovery; API documentation; user guide | member 4 | `pg_dump` CronJob and restore runbook, `docs/API.md` kept current, screenshots and user guide section of the README |

Slices 3 and 4 are bounded, start after the skeleton, and touch no file on the demo path. Reviews cross slices so every piece is read by someone who did not write it.

## Integration strategy

- One `compose.yaml` from week one; every slice adds to it, and `docker compose up --build` plus the test suite must pass on every PR (checked in CI).
- API contract first: the endpoint table (path, method, request, responses, status codes) is agreed before stage 2 and lives in `docs/API.md`, so the client, the real-time layer and the additive features can be written against it.
- Integration checkpoints: Saturday 15 Nov (cloud plus core features) and Saturday 22 Nov (everything, restart and scale test, demo dry run).

## Dependencies and coordination

- Stage 1 blocks everything and is the first two weeks' only goal.
- Spaces credentials and the DigitalOcean project are needed by stage 2 (uploads) and stage 3; set up in stage 1 by the cluster owner and shared as Kubernetes Secrets, never in chat.
- Weekly meeting Saturday; notes in `docs/meetings/`. Short written updates in WhatsApp: what landed, what is blocked.
- Code goes through a branch per Issue and a pull request with one review. Documentation is committed to `main` directly by the repository owner.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Kubernetes takes longer to learn than planned | stage 3 slips | minikube from week one; Swarm manifests are the fallback and reuse the Compose file |
| Real-time across replicas is harder than expected | feature 3 slips | it is not one of the two promised features; the demo runs without it |
| A member goes quiet | their slice stalls | slices 3 and 4 are off the demo path; open Issues are picked up by whoever is ahead |
| DigitalOcean cost | deployment goes down during grading | smallest nodes, one volume, budget stated in the proposal; cost split four ways; cluster deleted after grades |
| Database on a single PVC | pod loss is fine, volume loss is not | nightly `pg_dump` to Spaces (slice 4) |
| Scope creep toward document editing | nothing finishes | the out-of-scope list in ARCHITECTURE.md is final after the proposal |
