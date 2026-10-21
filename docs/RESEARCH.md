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
