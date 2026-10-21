# Project plan and responsibilities

Draft for proposal section 3 (project plan and team responsibilities). Individual contribution is read from the Git history, so every member owns a slice that shows up as their own commits, Issues and pull requests. Owners are added as people take slices (Nabeegh two, Eyrika two, Milton two; real-time and the second API name open).

## Principle

The demo path (sign in, upload, share, comment, live update, restart test, scale-out, monitoring) is kept to two slices. Every other slice is additive: if it is late, the demo still runs and the feature is shown as planned work. No slice waits on another slice once the skeleton exists.

## Stages

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

## Slices

| Slice | Owner | What lands in Git under the owner's name | On the demo path |
|---|---|---|---|
| Architecture, plan and proposal | Nabeegh | `docs/`, the proposal document | |
| Cloud: Kubernetes manifests, cluster, CI/CD, monitoring, autoscaling | Nabeegh | `k8s/`, `scripts/`, `.github/workflows/`, `/metrics`, alert policies, deployment section of the README | yes |
| API and data: schema, migrations, auth and roles, documents, versions, upload to Spaces, comments | Eyrika, with a second person to be named | `api/src/db`, auth routes and role middleware, document and comment routes, their tests | yes |
| Real-time: Socket.IO server, Redis adapter, live comment and pin events | open | `api/src/services/realtime`, the client hook | planned feature |
| Frontend: sign-in, document list, upload, document view, share dialog | Milton | `web/` | yes, if the demo uses it |
| Tags, search, metadata export; email notifications | Eyrika | tag and search routes, CSV and JSON export, email integration, their tests | no |
| Backup and recovery; API documentation; user guide | Milton | `pg_dump` CronJob and restore runbook, `docs/API.md`, screenshots and user guide section of the README | no |

Seven slices for four people: the architecture slice is small once the proposal is in, and the two additive slices start after the skeleton. Reviews cross slices so every piece is read by someone who did not write it.

## Integration strategy

- One `compose.yaml` from week one; every slice adds to it, and `docker compose up --build` plus the test suite must pass on every PR (checked in CI).
- API contract first: the endpoint table (path, method, request, responses, status codes) is agreed before stage 2 and lives in `docs/API.md`, so the client, the real-time layer and the additive features can be written against it.
- Integration checkpoints: Saturday 15 Nov (cloud plus core features) and Saturday 22 Nov (everything, restart and scale test, demo dry run).

## Dependencies and coordination

- Stage 1 blocks everything and is the first two weeks' only goal.
- Spaces credentials and the DigitalOcean project are needed by stage 2 (uploads) and stage 3; set up in stage 1 by the cloud slice and shared as Kubernetes Secrets, never in chat.
- Weekly meeting Saturday; notes in `docs/meetings/` the same day.

## How we work

- **Issues.** Every task is an Issue, assigned to the person doing it. Questions about a task go in its Issue, with the person tagged, so the discussion stays next to the work.
- **Branches and pull requests.** Code: one branch per Issue (`feature/`, `fix/`, `ci/`), one pull request with `Closes #<n>`, one review from a teammate, squash and merge. Keep a pull request to one change so the review takes minutes. Documentation goes straight to `main`.
- **Commits.** `<type>(<scope>): <summary>`, imperative, under 50 characters. Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `ci`. Examples: `feat(api): add share link expiry`, `ci: run tests on pull requests`.
- **Reviews.** Comments are about the code. Run the branch locally before approving.
- **WhatsApp** is for coordination and high-level updates: meeting times, "the skeleton is merged", "I am blocked on X". The detail lives on GitHub; when something lands, the Issue is closed by the pull request and a line goes to WhatsApp so everyone sees it.
- **AI use** is logged in `ai-session.md` as the course requires, and each folder's README carries the practices that apply there so they can be given to any tool up front.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Real-time across replicas is harder than expected | feature 3 slips | it is not one of the two promised features; the demo runs without it |
| A slice stalls | its feature is late | additive slices are off the demo path; open Issues are picked up by whoever is ahead |
| Cluster not stable in time | stage 3 slips | manifests proven on minikube first; Swarm fallback from the same Compose file |
| DigitalOcean cost | deployment goes down during grading | smallest nodes, one volume, budget stated in the proposal; cost split four ways; cluster deleted after grades |
| Database on a single volume | pod loss is fine, volume loss is not | nightly `pg_dump` to Spaces |
| Scope creep toward document editing | nothing finishes | the out-of-scope list in ARCHITECTURE.md is final after the proposal |
