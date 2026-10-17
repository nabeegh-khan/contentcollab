# Architecture

Working draft for the 7 November proposal (section 2, "Objectives, architecture and key features", 50% of the proposal grade). Each decision records the options weighed and the reason for the choice, because the rubric scores reasoning, not the stack list. Items marked **proposed** are confirmed or changed at the team meeting.

## Objective

A stateful, cloud-native content review platform. A user uploads a document, PDF or image, shares it with named collaborators or by a scoped link, and the collaborators comment and annotate on it, with updates appearing live for everyone viewing the same version. Every required course technology is used by a real part of the system.

## System diagram

```
                           users (browser)
                                 |
                        HTTPS + WebSocket
                                 |
                    DigitalOcean Load Balancer
                   (created by the Ingress controller)
                                 |
  +--------------------------------------------------------------+
  |  DigitalOcean Kubernetes (DOKS), 2 worker nodes               |
  |                                                              |
  |   ingress-nginx + cert-manager (TLS)                         |
  |        |                                                     |
  |   api Deployment, 2 to 5 replicas (HPA on CPU)               |
  |   Node.js + Express + Socket.IO                              |
  |        |                        |                            |
  |   postgres StatefulSet x1       redis Deployment x1          |
  |   PVC on a DO Volume            (Socket.IO adapter,          |
  |   (block storage)                pub/sub across replicas)    |
  |                                                              |
  |   backup CronJob: pg_dump -> Spaces, nightly                 |
  +--------------------------------------------------------------+
            |                              |
   DigitalOcean Spaces              DigitalOcean metrics + alerts
   (uploaded files, S3 API)         Prometheus + Grafana (optional)

  GitHub Actions: lint, typecheck, tests on every PR;
  on merge to main: build image -> GHCR -> kubectl rollout
```

## Decisions

### D1. Orchestration: DigitalOcean Kubernetes (proposed)

| | Kubernetes (DOKS) | Docker Swarm |
|---|---|---|
| Course requirement | Deployments, Services, PersistentVolumeClaims; minikube locally first | service replication and routing-mesh load balancing (lecture 6) |
| Fit with the features we want | auto-scaling (HPA), readiness probes, rolling updates and secrets are built in | replication and secrets built in; no autoscaler |
| Learning cost | manifests and kubectl are new to the team; minikube on each laptop first | same Compose file with a `deploy:` section |
| Cost (third-party pricing pages, confirm on digitalocean.com) | about $12 per worker node per month, $12 load balancer, control plane free | two $6 droplets |
| Value beyond the course | Kubernetes is named in job postings; Swarm is not | low |

Proposed: **DOKS**. The build window runs from now to 24 November, not from the proposal date, so there is time to learn it, and the auto-scaling and high-availability advanced feature falls out of the same choice. Local development stays on Docker Compose; minikube is used only to test the manifests before the cloud cluster exists.

**Why not Fly.io as well.** The course allows DigitalOcean or Fly.io. Fly.io gives edge regions and machines without managing hosts (lecture 6, Assignment 3), but its Kubernetes service is a paid beta the course does not recommend, and splitting one system across two providers doubles the operations work for no extra mark. We take Fly.io experience from Assignment 3 and keep the project on one provider.

### D2. Persistence: PostgreSQL on a DigitalOcean Volume, files in Spaces

A managed database alone does not count as persistent storage in this course, so PostgreSQL runs in the cluster as a StatefulSet with a PersistentVolumeClaim backed by DigitalOcean block storage. Uploaded files do not go on that volume: with several API replicas, a file written to one pod's disk is invisible to the others. Spaces is S3-compatible object storage reachable from every replica; the API streams the upload to Spaces and keeps the metadata row (owner, version, size, checksum, object key) in PostgreSQL. The restart test for the presentation: delete the postgres pod, the PVC re-attaches, the data is still there.

Schema, first cut: `users`, `documents`, `document_versions` (one row per upload, object key in Spaces), `shares` (document, user or link token, role, expiry), `comments` (document version, anchor, author, body, parent for threads), `tags`, `document_tags`. Roles are Owner, Collaborator and Viewer, enforced by one middleware that loads the share row for the current user and document before any handler runs.

### D3. What "collaboration" means here

Content is the uploaded file. PDFs and images render in the browser; other types (docx, spreadsheets) are stored, versioned and downloadable but not rendered. Collaboration is review: threaded comments, annotation pins anchored to a page and position, @-mentions, and a new version uploaded when the content changes, with the version history and revert.

Live co-editing of document text, or a track-changes mode, is a different product. It needs a CRDT or operational-transform engine (Yjs is the usual library) and an editor, and track changes is harder still because every change becomes a reviewable object. A collaborator in another time zone is served by versions, comment threads and notifications, not by simultaneous typing. If the team wants live text editing later, it is one more feature on top of this architecture, not a change to it; it is not promised.

### D4. Real-time: Socket.IO with a Redis adapter

New comments, replies, annotation pins and mentions appear for everyone viewing the same document version without a refresh. With replicated API pods, an event received by pod A must reach a user connected to pod B; the Socket.IO Redis adapter does that through Redis pub/sub, which is why Redis is in the stack. The Ingress is configured for WebSocket upgrades.

### D5. Advanced features: two promised, four planned

The proposal commits to two features that are deterministic to build and to demo:

1. **Security**: email and password sign-in with bcrypt-hashed passwords, JWT sessions, role checks per route, share links with a token and an expiry, HTTPS from cert-manager and Let's Encrypt at the Ingress, credentials in Kubernetes Secrets (the Docker secrets pattern from lecture 5), never in the image or the repo.
2. **CI/CD**: GitHub Actions. On every pull request: lint, typecheck, Jest and Supertest against a PostgreSQL service container. On merge to `main`: build the image, push to the GitHub Container Registry, `kubectl set image` and wait for the rollout. The pipeline is what makes the deployment reproducible for the grader.

Planned beyond that, in order, and presented as completed only if they are:

3. **Real-time** (D4).
4. **Auto-scaling and high availability**: HorizontalPodAutoscaler on CPU, two worker nodes, readiness and liveness probes, a PodDisruptionBudget, a rolling update shown live.
5. **Backup and recovery**: a Kubernetes CronJob runs `pg_dump` nightly to Spaces; a restore is rehearsed once and documented.
6. **External services**: email on share and on @-mention through a transactional email API.

### D6. Monitoring

DigitalOcean droplet and cluster metrics with alert policies (CPU, memory, disk at 80%) are mandatory and free. The API exposes `/metrics` with `prom-client` (request count, latency histogram, error rate, upload bytes, connected sockets); Prometheus and Grafana run in the cluster from the community Helm chart if time allows. The presentation needs one alert firing and one dashboard; that is the evidence the rubric asks for.

### D7. Local development

One `compose.yaml` runs api, postgres and redis locally with healthchecks and `depends_on`, as in Assignment 2. Kubernetes manifests live in `k8s/` and are tested on minikube before DOKS. `.env.example` lists every variable; `.env` is ignored.

## Scope and feasibility

In: upload, versions, revert, share by user or link, roles, comments, annotations, tags, search by tag or title, JSON or CSV export of metadata, live updates. Out: rich-text editing, track changes, formatting, mobile. The out list is the answer to "how the final proposal differs from initial thinking" in section 4 of the proposal, where the 10 October notes listed a Google Docs style editor.

## Open questions for the team

- Confirm D1 (Kubernetes) and D3 (review, not editing).
- DigitalOcean billing: nobody has credit left from Assignment 1; one account hosts the cluster and the cost is split. GitHub Student Developer Pack credit is worth checking for each member.
- PDF annotation in the browser: pdf.js with our own overlay, or pins anchored to page number and coordinates only.
