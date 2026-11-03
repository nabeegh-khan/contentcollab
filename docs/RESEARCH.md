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

Control plane free; Basic nodes from $12/month each; load balancer from $12/month; volumes from $10/month ([DigitalOcean](https://www.digitalocean.com/pricing/kubernetes)). Two nodes, one load balancer and one volume is about $46/month, rising to about $60 with snapshots, extra volume space or a third node during the autoscaling demo: $12 to $15 each for four people. The high-availability control plane ($40/month) is not needed.

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
