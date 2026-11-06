# Build log

Dated record of what was built on the cluster, each decision with the option it beat, and what went wrong with its cause and fix. Times are Toronto time. Decisions that shape the design stay in [ARCHITECTURE.md](ARCHITECTURE.md); this file records how the build went. Practice IDs refer to [PRACTICES.md](PRACTICES.md).

Entry format: what was done; decision and the option it beat; evidence; sources checked, with the date checked.

## 4 November 2026

### Cluster created (#59)

- **Done:** DigitalOcean Kubernetes cluster `contentcollab` in `tor1`, Kubernetes 1.37.0-do.2, two `s-2vcpu-2gb` worker nodes, created by `scripts/cluster-up.sh` in 7 min 38 s.
- **Decision:** two nodes of the smallest size that fits two API replicas, PostgreSQL, Redis and the two controllers. One node was cheaper but gives no node-level redundancy (D1); larger nodes cost more than the load test needs. If the autoscaling demo runs out of room, the node pool grows by one.
- **Cost:** about US$54 a month: two nodes at US$18, one load balancer at US$12, Spaces at US$5, a 5 GiB volume under US$1, control plane free.
- **Sources (checked 4 Nov):** [Droplet pricing](https://www.digitalocean.com/pricing/droplets), [Kubernetes pricing](https://www.digitalocean.com/pricing/kubernetes), [Spaces pricing](https://www.digitalocean.com/pricing/spaces-object-storage).

### Traffic and certificates installed (D11)

- **Done:** Gateway API CRDs (standard channel, from NGINX Gateway Fabric v2.8.0), NGINX Gateway Fabric 2.8.0 and cert-manager v1.19.2 with Gateway API support, all by Helm.
- **Found:** DOKS 1.37 already ships the Gateway API CRDs and a `cilium` GatewayClass. Applying our CRDs updated them in place (the `last-applied-configuration` warnings in the bring-up output).
- **Decision:** keep NGINX Gateway Fabric (`nginx` class) as D11 records. Cilium's built-in gateway would remove one controller, but it was not evaluated before bring-up and would change D11; noted as an alternative, not adopted.
- **Sources (checked 4 Nov):** [NGINX Gateway Fabric Helm install](https://docs.nginx.com/nginx-gateway-fabric/install/helm/).

### Application deployed, pinned to a commit (INF-9)

- **Done:** API (2 replicas), PostgreSQL (StatefulSet) and Redis applied; the API image moved from `latest` to the commit tag `1264a07`.
- **Evidence:** `rollout status` showed one new pod ready before each old pod terminated; the two API pods run on different nodes; claim `data-postgres-0` is Bound, 5 GiB, `do-block-storage`.

### Incident: Gateway and route created in the wrong namespace

- **Symptom:** the bring-up script reported no Gateway address, and `kubectl -n contentcollab get svc` showed no load balancer after 19 minutes.
- **Cause:** the Gateway and HTTPRoute were created in `default`, where the controller gave them a load balancer (209.38.8.133). The base kustomization sets `namespace: contentcollab`, but that field applies only to the resources of the kustomization that declares it; `gateway.yaml` is listed in the `doks` overlay, which set none. In `default` the route's backend `api` does not exist and the certificate issuer's HTTP-01 solver, which points at `contentcollab/contentcollab`, could not have issued a certificate.
- **Fix:** the `doks` overlay sets the namespace too, and CI fails if any rendered object other than the Namespace sits outside `contentcollab`. The check was pushed before the fix: CI run 41903297929 failed on `Gateway/contentcollab`, and run 41903563958 passed once the overlay set the namespace (#59). The objects in `default` are deleted after their replacements exist, so the load balancer address changes once before DNS is set.
- **Sources (checked 4 Nov):** [Kustomize `namespace`](https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/namespace/), [GitHub Ubuntu 24.04 runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) (yq 4 preinstalled, used by the check).

### Controller telemetry turned off

- **Found:** the NGINX Gateway Fabric controller logged a timeout exporting product telemetry to NGINX.
- **Decision:** `nginxGateway.productTelemetry.enable=false`. The data is usage reporting to the vendor; nothing in the project uses it, and the errors would clutter the logs Datadog collects.
- **Sources (checked 4 Nov):** [chart values for v2.8.0](https://github.com/nginx/nginx-gateway-fabric/blob/v2.8.0/charts/nginx-gateway-fabric/values.yaml).

## 6 November 2026

### Session affinity for live updates (D12)

- **Decision:** unchanged from 24 October: sticky sessions with the Socket.IO Redis adapter, WebSocket-only as the fallback. D12 now names where affinity comes from: NGINX Gateway Fabric 2.8's cookie session persistence, or `ip_hash` in an UpstreamSettingsPolicy, which needs the load balancer to pass the client IP.
- **Evidence:** cookie persistence works on NGINX Open Source from NGF 2.8. It is an experimental Gateway API field that needs the experimental CRDs, and the route-level field is deprecated in favour of a Backend resource. A DigitalOcean HTTP load balancer keeps the client IP only with PROXY protocol; a network load balancer keeps it natively.
- **Sources (checked 6 Nov):** [NGF 2.8 release blog](https://blog.nginx.org/blog/nginx-gateway-fabric-2-8-ip-allow-and-deny-lists-passive-health-checks-and-cookie-based-session-persistence), [NGF session persistence](https://docs.nginx.com/nginx-gateway-fabric/traffic-management/session-persistence/), [DOKS load balancer settings](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/).

### Advanced features (D5)

- **Decision:** four committed (security, CI/CD, real-time, auto-scaling with high availability), two stretch goals (backup and recovery, external email). Real-time and auto-scaling moved up because the HPA is in `k8s/base`, the cluster has run since 4 November, and #69 holds the load test.
- **Open:** nothing in the manifests yet keeps the two API replicas on different nodes. They were on different nodes on 4 November by scheduling, not by rule.
- **Sources (checked 6 Nov):** [course project handout](https://www.eecg.utoronto.ca/~cying/courses/ece1779-cloud/project/handout/), "Advanced Features (Must implement at least two)".

### API replicas spread across nodes (#69, PR #78)

- **Found:** nothing kept the two API replicas on different nodes. The scheduler's default spread (hostname and zone) does not score nodes missing either label, and our nodes (v1.37.0) have no `topology.kubernetes.io/zone` label (`kubectl get nodes`).
- **Decision:** a topology spread constraint on `kubernetes.io/hostname`, `maxSkew: 1`, `ScheduleAnyway`, with `matchLabelKeys: [pod-template-hash]`. Required pod anti-affinity was rejected: one pod per node would leave replicas 3 to 5 and the rolling-update surge pod Pending on two nodes. `DoNotSchedule` was rejected: a drained or lost node still counts as a domain, so replacement pods would wait.
- **Check first:** a CI step asserts the constraint in both rendered overlays. Run 42286395192 failed on the current manifests; run 42287294841 passed with the constraint.
- **Sources (checked 6 Nov):** [Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/), [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/).
