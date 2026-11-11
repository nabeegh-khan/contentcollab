# Research

What we checked on 21 October, and what the team decides on Saturday.

## Ingress: ingress-nginx is retired

The architecture puts ingress-nginx in front of the cluster. Kubernetes retired it in March 2026: existing installs still run, but there are no more releases or security fixes. The recommended replacement is the Gateway API ([Kubernetes blog](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)).

| Option | What it means for us | Cost |
|---|---|---|
| Gateway API with a maintained controller | The supported path; TLS from cert-manager still works | New objects to learn (Gateway, HTTPRoute) |
| DigitalOcean Load Balancer Service with its own Let's Encrypt certificate | Fewest moving parts; TLS ends at the load balancer | Path routing to `web` and `api` needs two load balancers or an app-level proxy |

## Real-time across replicas

With more than one API pod, Socket.IO needs every request of one session to reach the same pod, unless clients use WebSocket only. The Redis adapter forwards broadcasts between pods; it does not route connections ([Socket.IO docs](https://socket.io/docs/v4/using-multiple-nodes)).

- Simplest: WebSocket-only transport on the client (`transports: ["websocket"]`), so round-robin balancing works.
- Set the proxy's idle timeout above Socket.IO's 45 seconds (ping interval plus timeout), or connections drop.

## Cost on DigitalOcean

Rechecked 4 November against DigitalOcean's pricing pages: about US$54 a month for two US$18 nodes, one US$12 load balancer and US$5 of Spaces, with the control plane free ([Droplets](https://www.digitalocean.com/pricing/droplets), [Kubernetes](https://www.digitalocean.com/pricing/kubernetes), [Spaces](https://www.digitalocean.com/pricing/spaces-object-storage)). The 21 October estimate used the US$12 node size, which has one vCPU; the cluster runs two-vCPU nodes. The high-availability control plane (US$40 a month) is not needed.

## Persistence

A DigitalOcean volume attaches to one node at a time, so PostgreSQL runs as a single replica; scaling applies to `api` and `web`, not the database. The restart test (delete the postgres pod, data survives) is the evidence the presentation rubric asks for.

## For Saturday

- Gateway API (proposed) or a DigitalOcean load balancer?
- WebSocket-only Socket.IO (proposed), or sticky sessions?
- Who hosts the cluster, and do we split the cost?
- Who takes real-time, and who joins Eyrika on the API?

## Job queue for the worker (31 October)

The worker takes everything slow out of the request path (ARCHITECTURE.md D9). The queue was chosen on 17 October without a written comparison; this is it.

| Option | What it is | Why or why not |
|---|---|---|
| BullMQ on Redis ([docs](https://docs.bullmq.io/)) | Job queue library for Node; jobs, retries with backoff, concurrency and delayed jobs stored in Redis | Chosen. Redis is already in the stack for the Socket.IO adapter, so the queue adds no service; jobs survive a worker restart; the API and the worker share one small library |
| pg-boss ([docs](https://github.com/timgit/pg-boss)) | The same idea on PostgreSQL, using `SKIP LOCKED` | Would remove the Redis dependency for jobs, but Redis stays for Socket.IO anyway, and polling a table is slower to pick up work |
| RabbitMQ | A message broker with its own protocol (AMQP) and container | Proper routing and acknowledgements, but one more service to run, monitor and explain for a queue with a handful of job types |
| Kafka | A distributed log for event streams | Built for volumes and retention this project never reaches |
| Bull | BullMQ's predecessor | Maintenance mode; BullMQ is the maintained successor by the same authors |

Consequence for failure handling: a job that throws is retried with backoff, and a worker killed mid-job leaves the job in Redis for the next worker (proposal 2.4). The first job type, `ping`, exists to prove that path before the summary and email jobs are written.

## Monitoring stack and cloud cost (checked 11 November 2026)

Question: should Prometheus and Grafana replace Datadog (#100), and what does the cluster cost to run until the final deliverable on 5 December? Decision in ARCHITECTURE.md D17.

| Finding | Source |
|---|---|
| Students get a free Datadog Pro account for up to 10 hosts, for two years, through the GitHub Student Developer Pack | [GitHub Education pack](https://education.github.com/pack); [Datadog: free accounts for students](https://www.datadoghq.com/blog/datadog-github-student-developer-pack/) |
| The community Prometheus chart sets no resource requests by default; a sized Prometheus server is commonly given 512 MiB requested, Grafana about 128 MiB | [prometheus-community/helm-charts, prometheus values.yaml](https://github.com/prometheus-community/helm-charts/blob/main/charts/prometheus/values.yaml) |
| The handout requires provider metrics and alerts and lists eight advanced features; Prometheus and Grafana are not named | [ECE1779 project handout](https://www.eecg.utoronto.ca/~cying/courses/ece1779-cloud/project/handout/) |
| Cluster memory on 11 November: 74% and 82% used on the two s-2vcpu-2gb nodes | `kubectl top nodes` |
| The DOKS control plane is free; the high-availability control plane costs US$40 a month, prorated hourly | [DigitalOcean Kubernetes pricing](https://docs.digitalocean.com/products/kubernetes/details/pricing/) |
| High availability cannot be turned off once enabled on a cluster | [How to enable high availability](https://docs.digitalocean.com/products/kubernetes/how-to/enable-high-availability/) |
| Worker nodes and the cluster's load balancer are billed at Droplet and Load Balancer rates | [DigitalOcean Kubernetes pricing](https://docs.digitalocean.com/products/kubernetes/details/pricing/) |
| Spaces Standard Storage is US$5 a month for 250 GiB and 1 TiB transfer, prorated hourly when all buckets are destroyed | [Spaces pricing](https://docs.digitalocean.com/products/spaces/details/pricing/) |
| Month-to-date usage on 11 November: US$23.15 including 13% HST. Hourly rates from the invoice preview: HA control plane US$0.0595, two nodes US$0.0538, load balancer US$0.0223, 5 GiB volume under US$0.001 | `doctl balance get`, `doctl invoice get preview` |

What it means: at these rates the cluster costs about US$3.70 a day with tax, and the HA control plane is 44% of it. Running unchanged to 5 December adds about US$90. Without HA the daily cost falls to about US$2.10. HA was not chosen in any design decision; the course needs scaling and high availability of the application (replicas, HPA, PodDisruptionBudget), which run on the worker nodes, not the managed control plane.

## Cluster cost: why HA is on, what a rebuild changes, what the node pool can do (checked 11 November 2026)

Question: how do we cut the bill without losing the demo, and what does each option really save? The plan built on it is [COST_PLAN.md](COST_PLAN.md). Read-only on the running cluster and the account; nothing was changed.

| Finding | Source |
|---|---|
| Why HA is on: with `--ha` omitted, the API applies a version-specific default, true for Kubernetes 1.36.0 and later. The cluster was created at the default `latest` (1.37), so it got HA by default, with no design decision behind it. A rebuild at 1.36, as D13 plans, would get it again unless `--ha=false` is passed | [`doctl kubernetes cluster create`](https://docs.digitalocean.com/reference/doctl/reference/kubernetes/cluster/create/) (doctl v2.4.0, generated 11 November); `doctl kubernetes cluster get contentcollab`: `ha: true`, `1.37.0-do.2` |
| HA is US$40 a month, prorated hourly; the standard control plane is free | [Kubernetes pricing](https://docs.digitalocean.com/products/kubernetes/details/pricing/), last verified 5 November |
| Once enabled, HA cannot be disabled. A rebuild is the only way off it | [Enable high availability](https://docs.digitalocean.com/products/kubernetes/how-to/enable-high-availability/), last verified 12 August |
| Bundled-plan worker nodes are billed per second at Droplet prices, with a monthly cap of 672 hours (28 days); the invoice rate for our nodes (about 0.0269 an hour each) fits that plan. s-2vcpu-2gb is US$18 a month (US$0.02679 an hour), s-2vcpu-4gb US$24 (US$0.03571) | [Kubernetes pricing](https://docs.digitalocean.com/products/kubernetes/details/pricing/); [Droplet pricing](https://docs.digitalocean.com/products/droplets/details/pricing/), last verified 26 October; `doctl compute size list`, 11 November |
| Load balancer: regional HTTP US$12 a month, regional network US$15. The invoice line "(small) Public Load Balancer" is US$3.30 for 148 hours, US$0.0223 an hour, which is US$15 over 672 hours: the cluster's balancer is the network type (D12), so the earlier "US$12 load balancer" figure in this file and in D1 is low by US$3. A second balancer appears on the invoice for one hour on 4 November and is gone | [Load balancer pricing](https://docs.digitalocean.com/products/networking/load-balancers/details/pricing/), last verified 26 October; `doctl invoice get preview` |
| Invoice preview lines, 4 November to 11 November 00:00 UTC (USD): HA control plane 8.87 (149 h), two nodes 7.96 (148 h), load balancer 3.30 (148 h), 5 GiB volume 0.11, a second balancer 0.02 (one hour on 4 November), trial credits -1.81 (1.02 + 0.79), HST 2.40 (13% of the amount after the credit). The balance is a separate figure, read at 06:15 UTC on 11 November: month to date 23.15. The two do not reconcile line by line (different cut-off times, credit and tax order); the hourly rates are what the projections use | `doctl invoice get preview`, `doctl balance get` |
| Autoscaling is set per pool with `auto-scale`, `min-nodes`, `max-nodes`, at creation or later; the scale-down respects PodDisruptionBudgets; the droplet limit on the account is 25. The two pages disagree on the floor: the autoscaler page allows a minimum of 0, the `doctl` page says scale to zero is not supported. We use a minimum of 1 | [Cluster autoscaler](https://docs.digitalocean.com/products/kubernetes/how-to/autoscale/), last verified 29 October; [`doctl kubernetes cluster create`](https://docs.digitalocean.com/reference/doctl/reference/kubernetes/cluster/create/) |
| One node is too small for today's workload. Allocatable memory is 1,499,736 KiB (about 1,464 MiB) per node. Pod memory requests total 2,140 MiB: 1,316 MiB that run once (postgres 256, two metrics-server 400, two coredns 340, two api 256, redis 64, others) plus 824 MiB of DaemonSet pods (cilium 332 and do-node-agent 80 on each node). On one node that is 412 + 1,316 = 1,728 MiB, 264 MiB over, before the 768 MiB the Datadog agent will request. Datadog is not installed yet (no `datadog` namespace) | `kubectl describe nodes`, `kubectl get pods -A -o json`, 11 November |
| `doctl kubernetes cluster delete --dangerous` also deletes the load balancers, volumes and volume snapshots; without it they are left and keep billing | [`doctl kubernetes cluster delete`](https://docs.digitalocean.com/reference/doctl/reference/kubernetes/cluster/delete/), generated 11 November |
| Let's Encrypt: 5 certificates per identical set of names every 7 days (one refills every 34 hours); 50 per registered domain every 7 days. Our certificate was issued on 4 November (revision 1), so a rebuild uses one of the five | [Rate limits](https://letsencrypt.org/docs/rate-limits/); `kubectl get certificate`, 11 November |
| Exchange rate: 1.4181 Canadian dollars per US dollar on 10 November 2026, the latest daily average | [Bank of Canada Valet, FXUSDCAD](https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=3) |
| The DNS record `contentcollab.app` has a TTL of 300 seconds and points at the balancer (209.38.10.245). The database has no tables | `https://dns.google/resolve`, `psql \dt`, 11 November |

What it means: the control plane's HA costs US$1.61 a day of the US$3.69 and is not needed, but it is on by default for new clusters from 1.36, so every rebuild script must say `--ha=false`. Removing it needs a rebuild; the database is empty, so the cheapest moment to rebuild is before the schema lands. An autoscaling minimum of 1 is the right setting but will not by itself save a node: with today's requests the autoscaler cannot move everything onto one s-2vcpu-2gb node, so the pool stays at two. The budget is a separate problem: see COST_PLAN.md.

## Deployment after the final deliverable (checked 11 November 2026)

The [project handout](https://www.eecg.utoronto.ca/~cying/courses/ece1779-cloud/project/handout/) requires a live URL in the final report and says the deployment should remain online during the grading period; teams may shut it down only after the instructors announce that grading is complete. If graders cannot reach it, they contact the team and give time to restart it, and occasional downtime from platform instability is not penalised. The handout gives no date for marks. Plan: keep the cluster online after 5 December on the smallest setup that still serves the app (one s-2vcpu-4gb node instead of two s-2vcpu-2gb, about US$12 a month less), and delete it the day the announcement is posted. Each day after 5 December costs about CAD 3 at the two-node rate.

## Monitoring that fits two 2 GB nodes (checked 11 November 2026)

What was checked for ARCHITECTURE D18: what the course requires, what DigitalOcean provides without an agent, what a Datadog agent or a small Prometheus needs, and how much memory the cluster has left. Pages were read on 11 November 2026.

| Finding | Source |
|---|---|
| Monitoring is "Required for ALL projects" and is not an advanced feature: "Integrate monitoring using provider tools (e.g., DigitalOcean metrics/alerts for CPU, memory, disk; Fly.io logs/metrics)" and "Set up basic alerts or dashboards for key metrics". Using metrics, logs or traces in the frontend is optional. The advanced features list is separate (serverless, real-time, auto-scaling and high availability, security, CI/CD, backup, external services, edge) | [Course project handout](https://www.eecg.utoronto.ca/~cying/courses/ece1779-cloud/project/handout/) |
| Every DOKS cluster comes with the DigitalOcean metrics agent, so basic metrics are available by default for the cluster, each node pool and each worker node: CPU usage, 1-, 5- and 15-minute load average, memory usage, disk usage and disk I/O, in the cluster's Insights tab. Memory excludes cached memory, which can be released on demand | [View basic performance metrics for nodes](https://docs.digitalocean.com/products/kubernetes/how-to/monitor-basic/) |
| `kubectl top node` can report higher memory than the Insights tab, because it includes reclaimable buffer and cache memory | [Autoscale a cluster with horizontal pod autoscaling](https://docs.digitalocean.com/products/kubernetes/how-to/set-up-autoscaling/) |
| DigitalOcean Monitoring is a free, opt-in service. Resource alerts cover CPU, memory, disk, load average, disk I/O and bandwidth, notify by email or Slack. Kubernetes worker nodes include the metrics agent by default, and alerts for them are assigned by tag rather than by name because nodes are recycled | [Create, edit and delete resource alerts](https://docs.digitalocean.com/products/monitoring/how-to/manage-resource-alerts/), [Monitoring features](https://docs.digitalocean.com/products/monitoring/details/features/) |
| Datadog's own Kubernetes example sets the Agent container's request at 200m CPU and 256 MiB (the same example for GKE Autopilot), and warns that Autopilot's default limit of 50m CPU and 100 MiB may lead the Agent container to be killed for memory | [Kubernetes distributions](https://docs.datadoghq.com/containers/kubernetes/distributions/) |
| Prometheus limits storage with `--storage.tsdb.retention.time` and `--storage.tsdb.retention.size` (disk, not memory); `--auto-gomemlimit` is on by default and sets the Go memory limit from the container's memory limit. The pages give no memory figure per series, so the sizes in D18 for option (b) are estimates | [Storage](https://prometheus.io/docs/prometheus/latest/storage/), [Flags](https://prometheus.io/docs/prometheus/latest/command-line/prometheus/) |
| Allocatable memory 1,499,736 KiB (1,464.6 MiB) on each of two nodes. Requested by pods: node A 974 MiB (66%), node B 1,166 MiB (79%). In use (`kubectl top nodes`, 18:37 UTC): A 1,217 MiB (83%), B 1,126 MiB (76%). Largest users: cilium about 410 MiB on each node, each API pod about 138 MiB | `kubectl describe nodes`, `kubectl top nodes`, `kubectl top pods -A`, `kubectl get pods -A -o json`, 11 November 18:37 UTC |
| The API's `/metrics` returns 153 series (14,168 bytes), including the Node.js defaults | `kubectl exec deploy/api` read of `/metrics`, 11 November |

Arithmetic (2 x 1,464.6 = 2,929 MiB allocatable): unrequested 2,929 - 2,140 = 789 MiB; with the API at five pods (three more at 128 MiB requested) 405 MiB; in use 2,343 MiB, so 586 MiB not in use, and 172 MiB with three more API pods at about 138 MiB each. The Datadog agents request 768 MiB (D6), more than 405.

Not found: an official minimum memory for the Datadog Agent on Kubernetes, and an official memory per series for Prometheus. The cluster numbers are from before the rebuild without the high-availability control plane; the node size and the pods are unchanged by it.
