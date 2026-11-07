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
- **Sources (checked 4 Nov):** [NGINX Gateway Fabric Helm install](https://docs.nginx.com/nginx-gateway-fabric/install/helm/). Added 7 Nov, for the values `scripts/cluster-up.sh` and `cluster-down.sh` use: [cert-manager v1.19 Helm install](https://cert-manager.io/v1.19-docs/installation/helm/) (`crds.enabled=true`; the chart's current patch is v1.19.6, the script pins v1.19.2), [cert-manager v1.19 Gateway API usage](https://cert-manager.io/v1.19-docs/usage/gateway/) (`config.apiVersion`, `config.kind`, `config.enableGatewayAPI=true`), [cert-manager kubectl install, verifying](https://cert-manager.io/docs/installation/kubectl/) (the webhook is ready after the controller; `cmctl check api --wait`), [doctl kubernetes cluster create](https://docs.digitalocean.com/reference/doctl/reference/kubernetes/cluster/create/) (`--node-pool "name=…;size=…;count=…"`, `--wait`), [doctl kubernetes cluster delete](https://docs.digitalocean.com/reference/doctl/reference/kubernetes/cluster/delete/) (`--dangerous` also deletes load balancers and volumes; `--force` skips doctl's own prompt).

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

### Component diagram names the four committed advanced features

- **Changed:** the two generic badges ("Advanced feature 1" and "2") now read Security (on Kubernetes Secrets and the api) and CI/CD (on GitHub Actions). New badges in the same style: Real-time on Redis and Auto-scaling on the api, matching proposal section 2.7. The api box reads "2 to 5 replicas (HPA)", matching the HorizontalPodAutoscaler in `k8s/base/api.yaml`.
- **Layout:** the longer api title needed a wider box (330 px, same centre, so every arrow still meets it) and an 18 px title, the only title below 21 px. The Real-time badge sits inside the top of the Redis cylinder, because on the rim it would hide the arrowhead from the api.
- **Checked:** the PNG was re-rendered from the SVG at 1,600 × 920 in headless Chrome. A script over the rendered SVG found no overlapping text, every badge label inside its badge, and every title inside its box. The PNG was also inspected by eye.
- **Provenance:** both files keep the content-credentials (C2PA) manifest they carried since 3 November, in the SVG's metadata and the PNG's `caBX` chunk. It was signed for the earlier content, so a C2PA validator will now report that the files changed after signing.

### The autoscaler could not read CPU (#69, PR #72)

- **Found:** `kubectl get hpa` showed `cpu: <unknown>/70%` and `ScalingActive False, FailedGetResourceMetric`. DOKS serves no resource metrics API until metrics-server is installed, so the HPA had never been able to scale. A load test run in this state would have shown a flat replica count and passed it off as the cluster's limit.
- **Decision:** `scripts/metrics-server.sh` installs the upstream chart pinned at 3.14.0 (metrics-server 0.9.0, supported on Kubernetes 1.34 and later; the cluster runs 1.37), with two replicas and kubelet TLS verified, as DigitalOcean's own Marketplace stack does. The 1-Click install was rejected because it is a dashboard click and unpinned. `scripts/hpa-ready.mjs` exits 1 while the HPA cannot read CPU, and the load test refuses to start in that state.
- **Check first:** the readiness test went in before the module. CI run 42296688552 failed on it, and run 42297775626 passed. Against the live cluster the check still exits 1 until the install runs.
- **Sources (checked 6 Nov):** [DigitalOcean HPA guide](https://docs.digitalocean.com/products/kubernetes/how-to/set-up-autoscaling/), [metrics-server chart 3.14.0](https://github.com/kubernetes-sigs/metrics-server/blob/metrics-server-helm-chart-3.14.0/charts/metrics-server/Chart.yaml), [DigitalOcean Marketplace stack](https://github.com/digitalocean/marketplace-kubernetes/tree/master/stacks/metrics-server).

### metrics-server installed; first stepped load test (#69, PR #72)

- **Done:** metrics-server installed with `scripts/metrics-server.sh` (chart 3.14.0, metrics-server 0.9.0, two replicas, one per node). The HPA reads CPU (`cpu: 10%/70%`), and kubelet TLS works on DOKS without the insecure flag.
- **Run:** `BASE=https://contentcollab.app node scripts/loadtest.mjs`, steps of 60 s against `/health`:

| target req/s | achieved req/s | p50 ms | p95 ms | errors % | failed | API replicas at end of step |
|---|---|---|---|---|---|---|
| 10 | 9.2 | 59 | 75 | 0.00 | 0 | 2 |
| 25 | 23.0 | 58 | 88 | 0.00 | 0 | 2 |
| 50 | 46.1 | 58 | 92 | 0.00 | 0 | 2 |
| 100 | 92.2 | 60 | 87 | 0.00 | 0 | 2 |
| 200 | 184.3 | 64 | 95 | 0.18 | 20 | 3 |

- **Read:** CPU first crossed the 70% target during the 200 req/s step. The HPA went to 3 replicas near the end of that step and to 5 after the run had ended, so 60 s steps are shorter than its reaction time. With five pods one node reached 89% memory: on two 2 GB nodes, memory, not CPU, is the limit. Three of the five pods shared a node because the spread rule (#78) is not merged yet. Achieved rates run about 8% under target at every step, which points to the client's timer rather than the server.
- **Open:** the script does not record why the 20 requests failed (5xx or timeout); add that before the next run. Next runs use longer steps above 150 req/s and the rolling update under load.

### Second load test: 180 s steps, failure reasons recorded (#69, PR #72)

- **Change:** the load test now records why each request failed (HTTP status, timeout or the network error code). It checks node memory every 15 s and stops above 95%.
- **Run:** `BASE=https://contentcollab.app STEPS=150,200,250 STEP_SECONDS=180 node scripts/loadtest.mjs`, 17:08 to 17:17:

| target req/s | achieved req/s | p50 ms | p95 ms | errors % | failed | failure reasons | peak node memory % | API replicas at end of step |
|---|---|---|---|---|---|---|---|---|
| 150 | 138.1 | 62 | 102 | 0.12 | 30 | UND_ERR_SOCKET:30 | 93 | 5 |
| 200 | 184.2 | 63 | 95 | 0.00 | 0 | - | 92 | 5 |
| 250 | 229.8 | 64 | 107 | 0.00 | 0 | - | 91 | 5 |

- **Scaling:** the HPA went from 2 to 3 replicas at 17:08:58, to 4 at 17:09:13 and to 5 at 17:09:43, all within the first 85 s of the 150 req/s step. At 250 req/s CPU was still 78% of the target at five replicas, the HPA maximum, so five replicas is where this deployment stops scaling.
- **Failures:** all 30 were `UND_ERR_SOCKET` (the connection was closed from the server side), and all came in the step where the HPA added three pods. There were none at 200 or 250 req/s once five pods were ready. The likely cause is connections closed while the set of API pods changed; the script does not timestamp failures, so this is not confirmed.
- **Memory:** peak node memory was 93%, under the 95% stop. Three of the five API pods ran on one node, because the spread rule (#78) is not merged yet.
- **Open:** confirm the cause of the socket closures by timestamping failures against scaling events. The rolling update under load waits for #78 (note on #69).

## 7 November 2026

### Proposal file renamed to the Quercus submission name

- **Done:** `docs/PROPOSAL.md` is now `docs/ECE1779_Team22_Project_Proposal.md`, the exact name of the file each member submits on Quercus. The content did not change: 13,876 bytes, sha256 beginning `d35d288f`, the same blob as commit `d47d567`, 1,999 words by the submission count (URLs, table rules and pipes removed before counting). The six links in the README and in the 17, 24 and 31 October minutes point at the new name. Commit `dcd3786`.
- **Decision:** rename the file in the repository rather than keep a copy under the Quercus name. One file under one name lets anyone compare the repository and the submission byte for byte; a second copy would drift.
- **Check:** `git grep PROPOSAL.md` finds no remaining reference; the raw GitHub URL for the new path answers 200 with 13,876 bytes (checked 7 November, 9:50).

### Worker Deployment and the two-image deploy workflow (PR #60)

- **Done:** `k8s/base/worker.yaml` runs one worker pod with the API's ConfigMap and Secret; `deploy.yml` builds and pushes the api and worker images in a matrix and, once cluster credentials exist, sets both Deployments to the commit SHA.
- **Values and their basis:** `terminationGracePeriodSeconds: 60`, twice the Kubernetes default of 30 s, because the worker's SIGTERM handler calls BullMQ `worker.close()`, which in the TypeScript SDK waits for active jobs with no built-in timeout, so the pod's grace period is the only bound (Kubernetes pod lifecycle page and BullMQ "Graceful shutdown" guide, both checked 7 November 2026). `WORKER_CONCURRENCY: "2"` and the 512 MiB memory limit are starting values with no measurement behind them: the only job so far is the ping job from #58. Both are revisited when a real job exists and the load test (#69) covers the worker.
- **Not exercised:** the rollout step. No cluster credentials exist in the repository (deploy runs 41693157835, 41735879190 and 41899572808 all stopped at "No KUBECONFIG secret: image pushed, no rollout"); #76 replaces the KUBECONFIG check with doctl-issued credentials. One defect is carried in that step and left for #76 to remove with it: `kubectl apply -k k8s/doks` re-applies the `:latest` tag from the base before `set image` pins the SHA, so a deploy would roll each Deployment twice (INF-9).

### Cluster bring-up script hardened before merge (#59)

- **Change:** `cluster-up.sh` now waits for all three cert-manager Deployments (controller, cainjector, webhook) before applying the issuer, because the webhook comes up after the controller and the first `kubectl apply` of a ClusterIssuer can fail until it answers; it changes to the repository root so it runs from any directory; the sed that fills in the Let's Encrypt address uses `|` as delimiter so an address with `&` or `/` cannot break it; its closing line names the secret `deploy.yml` reads today (`KUBECONFIG`), with #76 as the change that replaces it; the cost comment matches ARCHITECTURE (US$48 for the cluster alone, US$54 with Spaces and the volume). CI now runs kubeconform on `k8s/doks/cluster-issuer.yaml` as well as the two overlays, since the script applies the issuer outside the overlay.
- **Not verified:** whether the 4 November run hit the webhook race; the bring-up output was not kept in enough detail to say. The wait costs nothing when the webhook is already ready.

### Test harness fails fast when PostgreSQL or Redis is down (#38, PR #71)

- **Change:** before the first test, the suite checks that PostgreSQL and Redis accept a TCP connection (1 s each) and fails at once with the host, port and the command that starts them (`docker compose -f compose.yaml -f compose.test.yaml up -d db redis`; see the correction below). Before this, a missing service showed as Jest's 5 s hook timeout with empty `redis:` error lines, which is what a teammate's local run produced on 7 November. The comment in the test named the compose service `postgres`; it is `db`.
- **Decision:** a TCP reachability check over retrying the clients longer. The clients' own retries hide the cause and lengthen the failure; the check names it and costs nothing when both services are up. Test written before the module, shown failing in CI first (TST-5).
- **Correction, same morning:** `compose.yaml` publishes neither the database nor the Redis port (CON-7), so `docker compose up -d db redis` alone does not let a laptop's `npm test` reach them. A `compose.test.yaml` override publishes both on `127.0.0.1` with the CI test credentials, on its own volume so the development database is untouched (Compose merges volumes by mount path and overrides environment and ports; Docker docs "Merge Compose files", checked 7 November). `api/jest.env.js` supplies the same `DB_*` and `REDIS_*` defaults as `ci.yml` when the variables are unset (Jest `setupFiles`). The option it beat: running the tests inside the api image, which the branch keeps test-free on purpose.
- **Second case, 1:55pm:** the same teammate's next run met a PostgreSQL of their own on 5432 (`bind: address already in use`): the test container never started, the reachability check passed against that server, and `/health` answered 503 because it refused the test credentials. `src/lib/dbReady.ts` now runs one `SELECT 1` before the first test and fails with host, port, user, database and the `TEST_DB_PORT=55432` remedy. Decision: a credentials query in the harness over documenting `TEST_DB_PORT` alone; the README already carried that hint and it was not found. Test written first, failing in CI on `5931cef`. The independent check before the merge added two things: network errors keep the start-the-services message (so the check is also right without the reachability check in front of it), and the query has a timeout so a server that accepts TCP but never answers also names itself. It also found that the practice ID `NET-2` cited above and in `compose.yaml` does not exist in `PRACTICES.md`; the rule is CON-7, this entry is corrected, and `compose.yaml`'s comment waits for its next code change. The override shares the Compose project with the development stack, which the README now states.

### Two cloud pull requests merged under the three-day rule (#59, #60)

- **Done:** #60 (worker Deployment, two-image deploy workflow) merged at 10:41 as `a2e0795`, closing #81; #59 (cluster bring-up and tear-down scripts) merged at 10:44 as `8f9e1e0`, part of #54, which stays open for the kubeconfig secret and the DNS record. Each branch was updated with main first and had green CI on that head (#60 run 42387423969, #59 run 42387640853); each had an internal check whose findings were fixed before the merge (entries above). Review windows had ended at 10:38 with no approving or requesting review; the comment review on #59 was answered on the pull request.
- **Deploy on merge:** run 42387590015 built and pushed both images (`contentcollab-api` and `contentcollab-worker`, tagged `a2e0795…` and `latest`) and stopped at the rollout step with "No KUBECONFIG secret", as the workflow is written. The cluster still runs the api image set by hand on 4 November and has no worker Deployment yet; the first rollout from CI waits for #76.
