# ContentCollab: project proposal

ECE1779 Introduction to Cloud Computing, Fall 2026.

Team: Nabeegh Khan (1001388152), Milton Wang (1009114192), Jyotiraditya Kale (1013397370), Yiqing Liu (1008052580).

## 1. Motivation

Owner: Yiqing Liu. Problem, intended users, why it is worth addressing, limitations of existing approaches.

## 2. Objectives, architecture and key features

### 2.1 Objectives

ContentCollab is a workspace where people share files and discuss them in place. Files, versions and comments stay together instead of scattering across email, chat and file copies.

Anyone can sign up, create a workspace and invite people as Owner, Editor, Commenter or Viewer, the roles Google Drive and Figma use; a link with an expiry admits people without an account. Everyone viewing a version sees new comments and pins (notes attached to a spot on the page) without refreshing. Each upload is a version, and any version can be restored.

The cloud objective is resilience: an API pod can crash, the database can move to another node, or a release can roll out, and no user loses a comment.

### 2.2 Architecture

![System architecture: browser to Gateway, api and web pods, worker, Redis, PostgreSQL on a volume, Spaces, CI and monitoring](https://raw.githubusercontent.com/nabeegh-khan/contentcollab/main/docs/img/architecture.png)

*Figure 1. System architecture. Source: `docs/ARCHITECTURE.md` (Mermaid), rendered to `docs/img/architecture.png`.*

A small React web app calls a JSON API through one Gateway, which terminates HTTPS for `contentcollab.app`; it exists because live comments in two browsers cannot be shown with curl. Files live in DigitalOcean Spaces, reachable from every replica; users, workspaces, versions and comments live in PostgreSQL.

### 2.3 Key design decisions

| Decision | Reason | Trade-off |
|---|---|---|
| Slow work runs in a worker on a Redis queue | A large file cannot exhaust the API's memory or block other users | One more service, same health checks as the API |
| Socket.IO with sticky sessions and the Redis adapter | Without affinity the long-polling fallback breaks across replicas; the adapter relays events between pods [3] | Needs affinity at the Gateway; WebSocket-only is the fallback |
| Gateway API, not ingress-nginx | ingress-nginx was retired in March 2026 [1] | New objects to configure |
| One PostgreSQL instance on a volume; files in Spaces | A volume attaches to one node; a file on one pod's disk is invisible to the others [4], [5] | No database failover; the restart test is rehearsed |
| Two small nodes | About US$46 a month shared by four [2] | Little headroom; load tests run before the demo |

### 2.4 Failure handling

API pods hold no state, so any pod can be killed or added without losing data. Each service is its own container with its own health check and is deployed on its own, so a failure degrades one capability rather than the system: without Redis, comments still save and live updates fall back to polling; without the worker, uploads still succeed; without PostgreSQL, the readiness probe fails and traffic moves away. New capabilities are added behind the existing API contract, not as changes to it.

| Risk | How we handle it |
|---|---|
| Race conditions | Optimistic locking: a write based on an older row version is rejected with 409; transactions and unique constraints prevent partial or duplicate rows |
| Retries | Uploads and jobs carry an idempotency key; timeouts and retries with backoff on every call; reconnecting clients fetch events after their last sequence number |
| Memory | Uploads stream to Spaces; every container has requests and limits |
| Silent failure | Alerts on 5xx rate, latency, pod restarts, queue depth and disk |
| Drift | Pinned base images and lockfile installs; the image tested in CI is the one deployed, after a migration Job |

### 2.5 How the required technologies are used

| Requirement | Our use |
|---|---|
| Docker and Docker Compose | One container per service; one Compose file runs the stack locally with health checks (API, PostgreSQL and Redis run since 25 October) [6] |
| PostgreSQL | Users, workspaces, roles, versions and comments, linked by foreign keys and changed inside transactions |
| Persistent storage | A persistent volume backed by a DigitalOcean Volume; the demonstration deletes the database pod and shows the data survives |
| Orchestration | DigitalOcean Kubernetes: Deployments, Services, a StatefulSet for PostgreSQL, a HorizontalPodAutoscaler for the API; manifests tested on minikube first, Swarm as the fallback if the cluster is unstable on 14 November |
| Deployment provider | DigitalOcean; Fly.io offers Kubernetes only as a paid beta |
| Monitoring | DigitalOcean alerts on CPU, memory and disk; request counts, errors and latency at `/metrics`; Datadog for dashboards and container logs |

### 2.6 Core features

- **Upload and preview.** PDFs and images render in the browser; other types are stored, versioned and downloadable.
- **Workspaces and roles.** Invitations by email; Owner, Editor, Commenter and Viewer checked by one middleware before every action.
- **Comments.** Threads, pins on a page position, @-mentions, live for everyone viewing the version.
- **Versions.** Every upload is a version; any version can be restored.

### 2.7 Advanced features

We commit to two:

1. **Security.** bcrypt password hashes, JWT sessions, role checks on every route, expiring share links, HTTPS at the Gateway, credentials in Kubernetes Secrets rather than images or the repository [6].
2. **CI/CD.** GitHub Actions has checked lint, formatting and types on every pull request since 28 October; tests against a PostgreSQL service container join as features land; a merge to `main` builds the images, pushes them to the GitHub Container Registry and rolls them out.

One planned extension, reported as finished only if it is: **autoscaling and high availability**, more API replicas under load, readiness probes, and a rolling update with no dropped requests.

### 2.8 Scope and feasibility

Live co-editing of text is out of scope: it needs a conflict-resolution engine and an editor, a separate product. We deploy before we build features, so deployment problems surface early; each feature ships with tests, so a change that breaks another member's part fails in CI; and the team uses the deployed system as each piece lands. The cluster runs by 14 November; features on the demo path freeze on 21 November, leaving the days before the 25 November presentation for load tests and two rehearsals. Each part has a named owner (section 3).

## 3. Project plan and team responsibilities

Owner: Milton Wang. From `PLAN.md`: stages, division of work, integration strategy, dependencies and coordination, risks.

## 4. Initial team reasoning and AI-assisted exploration

Owner: Jyotiraditya Kale. Initial understanding (10 October notes), technical hypotheses, open questions, how the thinking changed, one AI interaction with its evaluation, how the final proposal differs from the initial thinking.

## References

[1] Kubernetes, "Ingress NGINX retirement: what you need to know," Kubernetes Blog, Nov. 2025. https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/

[2] DigitalOcean, "Kubernetes pricing." https://www.digitalocean.com/pricing/kubernetes

[3] Socket.IO, "Using multiple nodes," Socket.IO v4 documentation. https://socket.io/docs/v4/using-multiple-nodes

[4] ECE1779 lecture slides, Lecture 3: DigitalOcean Volumes and Snapshots, slides 12–18, Fall 2026.

[5] ECE1779 lecture slides, Lecture 4: Docker Volumes, slides 90–94, Fall 2026.

[6] ECE1779 lecture slides, Lecture 5: Docker Secrets and Healthchecks, slides 28–51, Fall 2026.
