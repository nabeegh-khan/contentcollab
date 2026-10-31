# ContentCollab: project proposal

ECE1779 Introduction to Cloud Computing, Fall 2026. Due Saturday 7 November 2026, 11:59pm. One Markdown file, at most 2,000 words. Drafted in the shared Google Doc; each section's owner moves the settled text here.

Team: Nabeegh Khan (1001388152), Milton Wang (1009114192), Jyotiraditya Kale (1013397370), Yiqing Liu (1008052580).

## 1. Motivation

Owner: Eyrika. Problem, intended users, why it is worth addressing, limitations of existing approaches.

## 2. Objectives, architecture and key features

Owner: Nabeegh. From `ARCHITECTURE.md`: objectives and core functionality, the architecture, how each required technology is used, the advanced features, scope and feasibility.

## 3. Project plan and team responsibilities

Owner: Milton. From `PLAN.md`: stages, division of work, integration strategy, dependencies and coordination, risks.

## 4. Initial team reasoning and AI-assisted exploration

### 4.1 Initial Team Reasoning

Initially, our team reviewed the sample project ideas on the course website and chose the Content Sharing and Collaboration Platform. We wanted to build something that highlighted the cloud tools learned in class while providing a clear demo. Going through the suggested features, the project originally resembled a Google Docs clone. However, while outlining requirements, we hit a major design hurdle: live co-editing requires a complex conflict resolution engine to prevent document corruption. Realizing co-editing was a massive standalone product, we pivoted our scope to a document review tool instead. Our finalized scope focused on document uploading, version history, link sharing, live commenting with @-mentions and pins, search, and metadata export, backed by role-based access control (Owner, Collaborator, Viewer).

### 4.2 Exploration and Evaluation

During our second meeting's architectural planning, we decided on a React frontend container and background workers for bulk imports. For orchestration, we debated between Kubernetes and Docker Swarm. Kubernetes provided native autoscaling and volume management over Swarm's simpler setup, so we chose DigitalOcean Kubernetes (DOKS), testing manifests on minikube first with Swarm as a fallback. We also evaluated Fly.io, but since its Kubernetes service is a paid beta and we wanted to avoid managing two different cloud providers, we decided to stay entirely on DigitalOcean hosted on a single team member’s account.

In our third meeting, we audited our choices. We originally planned to use ingress-nginx, but an official Kubernetes blog post revealed it was retired in March 2026 without security fixes. We updated our architecture to the Kubernetes Gateway API to route /api and frontend traffic. To handle real-time commenting across API replicas, AI suggested enforcing WebSocket-only transport to avoid sticky sessions. We critically evaluated and rejected this advice because removing HTTP long-polling breaks connections behind firewalls. Instead, we implemented sticky sessions with a Redis adapter. Finally, we committed to JWT authentication and a GitHub Actions CI/CD pipeline, keeping autoscaling and transactional emails as planned extensions.

