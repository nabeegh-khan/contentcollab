# ContentCollab

**Upload a document, share it with the right people, and work on it together in real time.**

ContentCollab is a content sharing and collaboration platform: users upload documents and PDFs, share them with named collaborators or by link, and annotate and comment on them live. It is the team project for ECE1779 Introduction to Cloud Computing, University of Toronto, Fall 2026.

**Status:** proposal stage. Scope and architecture are being settled for the 7 November proposal; no application code yet.

## Contents

- [Team](#team)
- [What we are building](#what-we-are-building)
- [Architecture](#architecture)
- [Milestones](#milestones)
- [How we work](#how-we-work)
- [Repository layout](#repository-layout)
- [Local setup](#local-setup)

## Team

| Name | GitHub |
|------|--------|
| Nabeegh Khan | [@nabeegh-khan](https://github.com/nabeegh-khan) |
| Jyotiraditya Kale | [@Jyotiraditya7](https://github.com/Jyotiraditya7) |
| Milton Wang | [@MWang-max](https://github.com/MWang-max) |
| Eyrika Liu | [@Oct31yrika](https://github.com/Oct31yrika) |

## What we are building

The problem: teams review each other's work constantly (code, reports, designs), and the review usually happens somewhere other than the document itself, in email threads, chat messages or a second copy of the file. ContentCollab keeps the review on the document: one copy, one version history, comments and annotations anchored to the content, and sharing that is scoped to the people who should see it.

Features planned for the proposal, grouped the way the course grades them.

**Core (required)**

| Feature | Notes |
|---------|-------|
| Node.js REST API in Docker, run locally with Docker Compose | |
| PostgreSQL for users, files, versions, comments, on a persistent DigitalOcean Volume | state survives restarts and redeploys |
| Docker Swarm on DigitalOcean with service replication and load balancing | orchestration option A |
| Monitoring: storage usage and API performance, with alerts | DigitalOcean metrics |

**Advanced (at least two required; candidates)**

| Feature | Notes |
|---------|-------|
| Real-time collaboration over WebSockets: live comments, annotations, @-mentions | the hardest piece; concurrent edits must not corrupt document state |
| Security: authentication, Owner / Collaborator / Viewer roles, HTTPS, secrets management, scoped share links | |
| CI/CD with GitHub Actions: build, test, deploy | |

**Product features**

- Upload and manage documents and PDFs, with version history and revert.
- Share directly with a user or by link; link access limited to the people it was shared with.
- Comment, tag and annotate content; @-mention collaborators.
- Search by tags or metadata.
- Export content metadata as JSON or CSV.

## Architecture

Working sketch; the proposal will refine it.

```
            browser
               |
         HTTPS / WebSocket
               |
     +---------------------+
     |  Docker Swarm       |
     |  node.js api  x N   |   <- replicated, load balanced
     +---------------------+
          |            |
     PostgreSQL     file storage
     (DO Volume)    (DO Volume or Spaces)

  GitHub Actions: build image -> test -> deploy to Swarm
  DigitalOcean metrics: storage, API latency, error rate -> alerts
```

## Milestones

| Deliverable | Due |
|-------------|-----|
| Proposal: one Markdown file, max 2,000 words, each member submits on Quercus | Sat 7 Nov 2026, 11:59pm |
| Team Health Check | Mon 16 Nov 2026 |
| In-person presentations | Wed 25 Nov and Wed 2 Dec 2026 |
| Final deliverable: repo URL with README report, source, `ai-session.md`, video demo | Sat 5 Dec 2026, 11:59pm |

Weekly team meeting: Saturdays. Notes for every meeting go in [`docs/meetings/`](docs/meetings/).

## How we work

Taken from the course GitHub usage guide.

- **Issues.** One Issue per task; break large tasks into several. Assign it to whoever takes it.
- **Branches.** One branch per task: `feature/<name>`, `fix/<name>`, `docs/<name>`. `main` is protected; nothing is pushed to it directly.
- **Commits.** `<type>(<scope>): <imperative summary>`, under 50 characters. Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `ci`.
- **Pull requests.** One PR per Issue, `Closes #<n>` in the description, one teammate's approval required. Address feedback with further commits. Squash and merge; the branch is deleted automatically.
- **Reviews.** Keep PRs small. Comments are about the code, not the person.
- **Discussions.** Longer design questions go in Discussions; task tracking stays in Issues.
- **AI use.** Logged in `ai-session.md` as the course requires.

## Repository layout

```
docs/
  meetings/        one file per team meeting, YYYY-MM-DD.md
.env.example       environment variable template; copy to .env (never committed)
```

## Local setup

Written once the first service exists. Until then: clone, copy `.env.example` to `.env`, and watch this section.
