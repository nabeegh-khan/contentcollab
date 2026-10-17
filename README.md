# ContentCollab

Upload a document, share it with the right people, and review it together: comments, annotations and mentions that show up live for everyone looking at the same version.

Team project for ECE1779 Introduction to Cloud Computing, University of Toronto, Fall 2026.

**Status:** architecture and scope agreed 17 October (Kubernetes, review tool, small frontend); proposal in progress; skeleton on `feature/skeleton`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PLAN.md](docs/PLAN.md).

## Team

| Name | GitHub |
|------|--------|
| Nabeegh Khan | [@nabeegh-khan](https://github.com/nabeegh-khan) |
| Milton Wang | [@MWang-max](https://github.com/MWang-max) |
| Jyotiraditya Kale | [@Jyotiraditya7](https://github.com/Jyotiraditya7) |
| Eyrika Liu | [@Oct31yrika](https://github.com/Oct31yrika) |

## What it does

A user uploads a PDF, image or document. They share it with named people, or by a link that only works for the people it was shared with. Collaborators leave threaded comments and annotation pins on the content and @-mention each other; a new upload becomes a new version, and any version can be restored. PDFs and images render in the browser. Other file types are stored, versioned and downloadable.

This is a review tool, not an editor. Live text editing and track changes are out of scope; the reasons are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), decision D3.

## Stack

| Layer | Choice |
|-------|--------|
| API | Node.js, Express, Socket.IO, in Docker |
| Data | PostgreSQL on a DigitalOcean Volume (persistent storage); Redis for Socket.IO across replicas |
| Files | DigitalOcean Spaces (S3-compatible object storage) |
| Orchestration | DigitalOcean Kubernetes: Deployments, Services, PersistentVolumeClaims, HorizontalPodAutoscaler; minikube locally |
| Frontend | small React app served as static files by its own container |
| Background jobs | worker container on a Redis queue (BullMQ): bulk imports, thumbnails |
| Local development | Docker Compose |
| Monitoring | DigitalOcean metrics and alerts; `/metrics` endpoint for Prometheus and Grafana |
| CI/CD | GitHub Actions: lint and test on every pull request, build and deploy on merge to `main` |

Advanced features promised in the proposal: security (sign-in, roles, HTTPS, secrets) and CI/CD. Planned after those: real-time updates, auto-scaling and high availability, backups, email notifications.

## Timeline

Course deadlines are 11:59pm Toronto with no late submissions. The windows are what we work in.

| Window | What happens | Course deadline |
|--------|--------------|-----------------|
| 17 Oct to 24 Oct | architecture and plan agreed; API contract; team formation on Quercus | team formation, Sat 24 Oct |
| 19 Oct to 1 Nov | skeleton: Compose stack, schema and first migration, health endpoint, CI on pull requests, manifests on minikube | Assignment 3, Sat 31 Oct |
| 26 Oct to 7 Nov | proposal written from the architecture docs; core features under way | **proposal, Sat 7 Nov (15%)** |
| 2 Nov to 15 Nov | cloud: DOKS cluster, TLS, PostgreSQL on a volume with the restart test, autoscaling, alerts, deploy on merge | |
| 9 Nov to 22 Nov | real-time, additive features, integration checkpoints 15 and 22 Nov | health check, Mon 16 Nov; Assignment 4, Sat 21 Nov |
| 23 Nov to 24 Nov | project introduction, slides, two demo rehearsals | introduction Mon 23 Nov; slides Tue 24 Nov |
| 25 Nov and 2 Dec | presentations, 6 minutes plus Q&A, live demo required | **presentation (10%)** |
| 25 Nov to 5 Dec | README report, `ai-session.md`, video, deployment left running | **final deliverable, Sat 5 Dec (35%)** |

## Repository layout

```
api/                 the JSON API (Express, Socket.IO); routes, middleware, services, db, tests
web/                 the small React frontend, served as static files by its own container
worker/              background jobs on a Redis queue: imports, thumbnails, backup trigger
k8s/                 Kubernetes manifests, with minikube and DigitalOcean overlays
scripts/             cluster, volume, migration, backup and smoke-test scripts
tests/               cross-service checks: restart, scale, end-to-end smoke
.github/workflows/   CI on pull requests, deploy on merge to main
docs/
  ARCHITECTURE.md    decisions with the options weighed; the source for proposal section 2
  PLAN.md            stages, owners, integration, risks; the source for proposal section 3
  PRACTICES.md       the engineering practices we hold to, with their course sources
  PROPOSAL.md        the proposal, one section per owner, due 7 Nov
  API.md             the endpoint contract (written before feature work starts)
  meetings/          one file per team meeting, YYYY-MM-DD.md
.env.example         environment variable template; copy to .env, which is never committed
```

Each folder has a README saying what goes in it, its planned layout, and the practices that apply there. `compose.yaml` lands with the skeleton.

## How we work

- One Issue per task, assigned to whoever takes it.
- Code: one branch per Issue (`feature/`, `fix/`, `ci/`), one pull request per branch with `Closes #<n>`, one review from a teammate, squash and merge. Keep them small.
- Documentation goes straight to `main`; it does not need a pull request.
- Commits: `<type>(<scope>): <summary>` in the imperative, under 50 characters. Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `ci`.
- Every member commits their own work. Individual contribution is 15% of the grade and is read from the Git history.
- Meeting notes go in `docs/meetings/` the same day.
- AI use is logged in `ai-session.md`, as the course requires.

## Local setup

Written when the skeleton lands. Until then: clone, copy `.env.example` to `.env`.
