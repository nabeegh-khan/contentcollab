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
