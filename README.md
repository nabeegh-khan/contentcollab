# ContentCollab

Content sharing and collaboration platform: upload documents and PDFs, share them with named people or by link, and annotate and comment on them live. ECE1779 Introduction to Cloud Computing course project, University of Toronto, Fall 2026.

## Team

| Name | GitHub |
|------|--------|
| Nabeegh Khan | [@nabeegh-khan](https://github.com/nabeegh-khan) |
| Jyotiraditya Kale | [@Jyotiraditya7](https://github.com/Jyotiraditya7) |
| Milton Wang | [@MWang-max](https://github.com/MWang-max) |
| Eyrika Liu | [@Oct31yrika](https://github.com/Oct31yrika) |

## Milestones

| Deliverable | Due |
|-------------|-----|
| Proposal (one Markdown file, max 2,000 words, submitted by each member on Quercus) | Sat 7 Nov 2026, 11:59pm |
| Team Health Check | Mon 16 Nov 2026 |
| In-person presentations | Wed 25 Nov and Wed 2 Dec 2026 |
| Final deliverable (repo URL: README report, source, `ai-session.md`, video demo) | Sat 5 Dec 2026, 11:59pm |

Weekly team meeting: Saturdays 10:30am. Notes for every meeting go in `docs/meetings/`.

## Planned stack

Node.js backend, PostgreSQL on a persistent volume, Docker and Docker Compose locally, Docker Swarm on DigitalOcean for deployment, GitHub Actions for CI. Advanced features under consideration: real-time collaboration (WebSockets), security (authentication, HTTPS, secrets), CI/CD.

## How we work (from the course GitHub usage guide)

- One Issue per task. Break large tasks into several Issues. Assign the Issue to whoever takes it.
- One branch per task, named `feature/<short-name>`, `fix/<short-name>` or `docs/<short-name>`. `main` is protected: no direct pushes.
- Commit subject: `<type>(<scope>): <imperative summary>`, under 50 characters. Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `ci`.
- One Pull Request per Issue, with `Closes #<n>` in the description. Request a teammate's review. One approval is required; address feedback with further commits. Squash and merge; the branch is deleted automatically.
- Keep PRs small. Reviews are about the code, not the person.
- Longer-form design questions go in Discussions; task tracking stays in Issues.

## Repository layout

```
docs/
  meetings/      one file per team meeting, YYYY-MM-DD.md
.env.example     environment variables template; copy to .env (never committed)
```

## Local setup

To be written once the first service exists.
