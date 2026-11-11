# Cost plan

Written Wednesday 11 November 2026. **Status: a plan. Nothing on the account or the cluster has been changed, and the rebuild below waits for Nabeegh's go.** Evidence and sources are in [RESEARCH.md](RESEARCH.md), "Cluster cost: why HA is on, what a rebuild changes, what the node pool can do". All money is US dollars with 13% HST unless it says CAD.

## The short version

- The cluster costs **US$3.69 a day**. US$1.61 of that is the high-availability (HA) control plane, which the course does not need and which was not chosen in any design decision: DigitalOcean turns it on by default for new clusters from Kubernetes 1.36, and our cluster was created at 1.37.
- HA cannot be switched off. The only way off it is a rebuild, and the cheapest moment is now: **the database has no tables**, so nothing is lost. After a no-HA rebuild the cluster costs **US$2.08 a day**.
- **The CAD 60 target (US$42.31) is met only by plans that switch the cluster off for most of the project.** CAD 60 comes from Nabeegh's brief of 11 November ("CAD 60 total for the project"); the repository does not state it, and PLAN.md says the cost is split four ways, so if it is a per-person figure the conclusion changes (decision 0, section 7). Month to date is already US$23.15. With the deployment up all the time, as the documents say ("deployment left running", README and PRESENTATION.md; "through grading", PLAN.md), the total ends at about **CAD 116** from a rebuild on 12 November and **CAD 169** if nothing changes. The only plans under CAD 60 have the cluster off from 15 November to 1 December and skip the rehearsals and the 20 November dry run there (P3b, about **CAD 55**).
- The autoscaling floor of 1 node asked for **will be set in the rebuild** (it is not set today), but **it will not save a node**: today's pods do not fit on one s-2vcpu-2gb node (section 3).

## 1. Where the money is today

Month to date US$23.15 (`doctl balance get`, 11 November 06:15 UTC; this is the balance figure, not a sum of the invoice-preview lines, which stop at 11 November 00:00 UTC and are net of a US$1.81 trial credit: RESEARCH.md). The cluster has run since 4 November 19:22 UTC.

| Part | Rate per hour, before tax | Per day with tax | Share |
|---|---|---|---|
| High-availability control plane (US$40 a month) | 0.0595 | 1.61 | 44% |
| Two s-2vcpu-2gb nodes (US$18 each; the invoice shows 0.0538) | 0.0536 | 1.45 | 39% |
| Load balancer (network type, US$15 a month) | 0.0223 | 0.61 | 16% |
| 5 GiB volume | 0.0007 | 0.02 | under 1% |
| **Cluster total** | **0.1362** | **3.69** | |

The load balancer is US$15, not the US$12 in D1: the invoice line is US$3.30 for 148 hours. Budget: CAD 60 at 1.4181 (Bank of Canada, 10 November) is US$42.31, so **US$19.16 is left, which is 5.2 days at today's rate** (to about 16 November).

## 2. Options, per day

| Setup | Per day | Note |
|---|---|---|
| Now: HA, two 2 GB nodes, one load balancer | 3.69 | |
| **No HA, two 2 GB nodes** | **2.08** | the rebuild; saves 1.61 a day |
| No HA, one 4 GB node (US$24) | 1.59 | fits the workload, but a one-node cluster cannot show a node drain or pods spread across nodes (#68, D14); not recommended |
| No HA, one 2 GB node | 1.35 | does not fit (section 3) |
| Cluster off, Spaces only (US$5 a month) | 0.20 | needs a rebuild each time it comes back |

Every day the HA cluster keeps running instead of the no-HA one costs **US$1.61 more**.

## 3. Why the node pool will not shrink to one node

Allocatable memory is about 1,464 MiB per node (1,499,736 KiB). Pod memory requests total 2,140 MiB: 1,316 MiB that run once (postgres 256, two metrics-server 400, two coredns 340, two api 256, redis 64) and 824 MiB of per-node DaemonSets (cilium 332, do-node-agent 80 on each node). On one node that is 412 + 1,316 = **1,728 MiB, 264 MiB over**, before the Datadog agent (768 MiB, D6; not installed yet). The autoscaler only removes a node when everything fits on the rest, so with `min-nodes=1` the pool stays at two. Five api replicas (the HPA maximum) still fit on two nodes: 2,140 + 3 x 128 = 2,524 MiB against 2 x 1,464 = 2,928 MiB. A third node (US$0.03 an hour) appears only if the Datadog agent's 768 MiB is added (2,908 MiB against 2,928, too tight to pack). The setting is still right to have: it costs nothing, and it lets the pool add that node and give it back. Getting to one node would need about 300 MiB less in requests (one metrics-server replica saves 200 MiB; one api replica 128 MiB), which leaves no room for Datadog or for the scale-out demo, so it is not proposed.

## 4. What it adds up to by the end of 5 December

Month-to-date US$23.15 plus the projection from 11 November 06:15 UTC to the end of 5 December (UTC; 19:00 Toronto, a difference of about US$0.50), with Spaces at US$5 a month from 12 November. The formula, so it can be redone: for each period the cluster is up, hours x (nodes x 0.026786 + 0.059524 if HA + 0.022321 load balancer + 0.000744 volume) x 1.13, plus Spaces 0.007440 x 1.13 an hour from 12 November, with the hourly rates being the list price over 672 hours (a 4 GB node is 0.035714); CAD at 1.4181.

| Plan | Total USD | Total CAD | Against CAD 60 |
|---|---|---|---|
| P0 Nothing changes (HA, two nodes, up all the time) | 119.35 | 169 | +109 |
| P1b Rebuild without HA on Sun 15 Nov, up to 5 Dec | 86.45 | 123 | +63 |
| **P1 Rebuild without HA on Thu 12 Nov, up to 5 Dec** | **81.75** | **116** | +56 |
| P2 As P1, cluster off 15 to 19 Nov (back for the 20 Nov checkpoint) | 72.39 | 103 | +43 |
| P3 Windows only: HA cluster kept to Fri 13 Nov, then up to the checkpoint, up 1 to 3 Dec, on 5 Dec | 45.95 | 65 | +5 |
| **P3b As P3, but delete the HA cluster on Wed 11 Nov and rebuild Fri 13 Nov** | **38.56** | **55** | **-5** |

P3 and P3b have no cluster from 15 November to 1 December. That skips the 20 November integration checkpoint's restart and scale test and demo dry run (PLAN.md) and the 22 to 24 November re-recording on the cluster (PRESENTATION.md), and the team deploys nothing in that time. P3b rebuilds on the day before the checkpoint, which leaves one day to fix a problem, and it needs route B (section 6). Its headroom is about CAD 5: each day after 5 December costs US$2.28 (CAD 3.2), so P3b is back over CAD 60 if grading needs the deployment for more than about 1.6 days after 5 December.

What this says: the rebuild is worth doing in every plan, and sooner is better (P1 against P1b: US$4.70). Whether to go further and switch the cluster off between windows is a trade of money against what the project documents promise: a deployment that is up for the rehearsals and "left running". P2, P3 and P3b mean the cluster is rebuilt two or three times; each rebuild is about an hour of work, a new load balancer address, a DNS change and one more Let's Encrypt certificate (5 per 7 days is the limit; one is already used). They also need a backup to restore from once the database holds data, and there is no backup job yet (D5, stretch). The numbers after 5 December depend on when grading ends, which is not in the repository: each further day is US$2.08 plus US$0.20 for Spaces.

## 5. Calendar

Toronto time. Node counts assume autoscaling 1 to 3 on s-2vcpu-2gb, which stays at 2 (section 3). The "up" column is P1. P3 and P3b are off from Sun 15 Nov until Tue 1 Dec; P3b also deletes the HA cluster on Wed 11 Nov and has no cluster until the rebuild on Fri 13 Nov.

| Date | What | Cluster | Nodes |
|---|---|---|---|
| Wed 11 Nov | Today. HA cluster, US$3.69 a day | up (HA) | 2 |
| **Thu 12 Nov** | **Rebuild without HA, on his go** (section 6; P3b: Fri 13 Nov). Outage about an hour | rebuilt | 2 |
| Fri 13 Nov | Smoke checks, restart test with `DRAIN=1` (#68) rehearsed on the new cluster | up | 2 |
| Sat 14 Nov, 3:30pm | Checkpoint meeting (cloud plus core features) | up | 2 |
| Sun 15 to Wed 18 Nov | P1: up. P2, P3, P3b: off (`cluster-down.sh`; the team works on Compose) | P1 up, others off | 2 or 0 |
| Mon 16 Nov | Team Health Check due (no cluster needed) | | |
| Thu 19 Nov | P2: rebuild again (second certificate). P3, P3b: stay off | up in P1 and P2 | 2 |
| Fri 20 Nov | Integration checkpoint, everything in (PLAN.md) | up in P1 and P2 | 2 |
| Sat 21 Nov | Feature freeze | up in P1 and P2 | 2 |
| Mon 23 to Tue 24 Nov | Introduction and slides; demo rehearsed twice | up in P1 and P2 | 2 |
| Fri 27 to Sun 29 Nov | Recording of the demo video. **Date not in the repository: assumed, to be set** | up in P1 and P2 | 2 |
| Tue 1 Dec | Rehearsal on the presenting laptop (P3, P3b: rebuilt) | up | 2 |
| **Wed 2 Dec, 1:15pm** | **Presentation slot**; the node-drain demo needs two nodes | up | 2 |
| Sat 5 Dec | Final deliverable; deployment left running | up | 2 |
| After 5 Dec | Until grading ends (not known). `cluster-down.sh` when it does (INF-7) | up | 2 |

## 6. Rebuild runbook: **waits for Nabeegh's go**

Nothing below has been run. It deletes the live cluster, so it is his to start. Allow about an hour (an estimate: the load balancer and certificate take minutes, and no timing of a full bring-up has been recorded).

**Which script creates the cluster decides what you get.** `main`'s `scripts/cluster-up.sh` creates it at the default version with no `--ha` flag, which gives HA again (RESEARCH.md); it installs the older pins (cert-manager v1.19.2, NGINX Gateway Fabric v2.8.0); it does not install metrics-server, the alert policies or Datadog; and it refuses to start without `k8s/base/secrets.yaml`. Two ways:

- **A: after #94 merges, with the two-line change described in section 8.** #94 is a draft; with review requested today its three-day window ends on 14 November, so A means rebuilding after the checkpoint (plan P1b timing, US$4.70 more than P1). It brings the supported version pins, a dry run and the autoscaling flags.
- **B: now, with the cluster created by hand, then `main`'s `cluster-up.sh`**, which finds it and installs the rest:
  ```
  slug=$(doctl kubernetes options versions | awk '/^1\.36\./ {print $1; exit}')
  doctl kubernetes cluster create contentcollab --region tor1 --version "$slug" --ha=false \
    --node-pool "name=default;size=s-2vcpu-2gb;count=2;auto-scale=true;min-nodes=1;max-nodes=3" --wait
  ```
  B runs the older cert-manager and gateway pins on Kubernetes 1.36. D13 records that cert-manager 1.19 reached end of life on 8 July 2026 and that 1.21 supports Kubernetes 1.33 to 1.36; **whether 1.19 supports 1.36 has not been checked**, so B has that unknown, and #94's upgrade follows later.

Steps, in Git Bash from the repository:

1. **Preflight, read-only.** The database must still be empty: `kubectl --context do-tor1-contentcollab -n contentcollab exec postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dt"'` should print `Did not find any tables.` If it lists tables, take a dump first (`... pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`) and plan a restore. **Have `k8s/base/secrets.yaml` filled in with real values before step 4**: `cluster-up.sh` on `main` and on #94 stops at the start without it and applies it during the run (`scripts/app-secret.sh` is #98, not on `main`). Have `LETSENCRYPT_EMAIL` set.
2. **A only: a dry run that cannot touch the live cluster:** `DRY_RUN=1 CLUSTER_NAME=contentcollab-dry LETSENCRYPT_EMAIL=<address> bash scripts/cluster-up.sh`. A name that does not exist prints the create command: check it shows `--ha=false`, a `1.36` slug and `auto-scale=true;min-nodes=1;max-nodes=3`. Nothing is created.
3. **Delete the old cluster:** `bash scripts/cluster-down.sh` and type `contentcollab`. `--dangerous` removes the load balancer and volume with it (doctl docs, 11 November). Check nothing is left billing: `doctl kubernetes cluster list`, `doctl compute load-balancer list`, `doctl compute volume list` should show none of ours.
4. **Create and install:** A: `LETSENCRYPT_EMAIL=<address> bash scripts/cluster-up.sh`. B: the `doctl` command above, then the same `cluster-up.sh`. The cluster name stays `contentcollab`: `deploy.yml` saves its kubeconfig by that name.
5. **What the script does not install, on either route:** `bash scripts/metrics-server.sh` (without it the HPA reads no CPU); `bash scripts/alerts.sh` (the alert policies are tagged with the cluster id, so a rebuilt cluster has none; `ALERT_EMAIL` must be a verified address); the Datadog agent if wanted (`DATADOG_API_KEY`, then `cluster-up.sh` again; it adds 768 MiB of requests, section 3).
6. **New load balancer address:** the script prints it (`kubectl -n contentcollab get gateway`).
7. **DNS:** at name.com change the `A` record for `contentcollab.app` to the new address. The TTL is already 300 seconds. Check: `curl -s "https://dns.google/resolve?name=contentcollab.app&type=A"`.
8. **Certificate:** `kubectl -n contentcollab get certificate` until `contentcollab-tls` is Ready (certificate number two in the Let's Encrypt window), then `curl -sI https://contentcollab.app/health`.
9. **Take the plain-text copy off the Secret** the file-based apply left (SEC-10): once #98 is merged, `KUBE_CONTEXT=do-tor1-contentcollab bash scripts/app-secret.sh` (it keeps the values and removes the annotation; `k8s/README.md`; tested on a local k3s cluster in #98, not on DOKS).
10. **Smoke:** `BASE=https://contentcollab.app bash scripts/smoke.sh`, with `METRICS_BASE` pointing at a port-forward, because the Gateway does not route `/metrics` (`scripts/README.md`); then the restart test (#68, on its branch until it merges): `KUBE_CONTEXT=do-tor1-contentcollab DRAIN=1 bash scripts/restart-test.sh`.
11. **Confirm the saving:** `doctl kubernetes cluster get contentcollab -o json | jq '.[0].ha'` prints `false`; the next day's `doctl invoice get preview` has no new High Availability Control Plane hours and the hourly total is about 0.077 before tax.

Risks: the outage runs from step 3 to step 8; a failed certificate order still counts against the Let's Encrypt limit, so do not loop on it; once the schema (#37) holds data, a rebuild needs a dump and restore, and there is no backup job, so this is the cheap moment.

## 7. Decisions for Nabeegh

0. **What CAD 60 covers.** The team's total (as briefed on 11 November) or one person's share (PLAN.md and the proposal split the cost four ways). If it is per person, P1 is CAD 29 each and P0 CAD 42, and nothing here needs switching off.
1. **Go for the rebuild, and when, and which route.** Thursday 12 November by route B (older pins, one unknown) or after #94 merges by route A (about US$4.70 more). Each day of delay costs US$1.61.
2. **The budget against "deployment left running".** P1 (up all the time, CAD 116), P2 (CAD 103), P3b (CAD 55, no cluster from 15 November to 1 December, and over CAD 60 again if the deployment is needed more than about 1.6 days after 5 December), or raise the CAD 60 target. P3 (CAD 65) does not reach it.
3. **How long after 5 December** the deployment must stay up for grading.
4. **Autoscaling minimum** of 1 as asked (stays at 2 for now) or 2 (honest about today's capacity). Same cost today.

## 8. Not done, and limits

- No `doctl` create or delete, no change to the cluster, the account or any DNS record. Reads only: `doctl balance`, `invoice`, `compute size list`, `kubernetes cluster get` and `options versions`, `kubectl get`, `top`, `describe`, and one read-only `psql \dt`.
- The change for route A is a patch against #94's draft, not a pull request: #94 is still open and the script is another session's work. It is held locally, not in the repository. In substance: add `--ha=false` to the `doctl kubernetes cluster create` call, change the node-pool string to `name=default;size=$NODE_SIZE;count=$NODE_COUNT;auto-scale=true;min-nodes=$NODE_MIN;max-nodes=$NODE_MAX` (defaults 1 and 3, refused unless `NODE_MIN <= NODE_COUNT <= NODE_MAX`), and add two assertions and one test to #94's `cluster-up.test.mjs`. On a throwaway checkout of #94's head, those tests fail 2 of 30 against #94's script and pass 30 of 30 with the change.
- The projection assumes the invoice-preview hourly rates hold and that 13% HST applies to the whole cluster cost. The invoice preview applies the tax after a US$1.81 trial credit ("Inference Cloud Trial"); that credit is not counted, and the balance figure of US$23.15 cannot be rebuilt from the listed lines (they stop at 11 November 00:00 UTC; the balance is read at 06:15 UTC). The effect on any plan is under CAD 1. It excludes traffic and snapshot charges.
- The `doctl` page and the autoscaler page disagree on whether a pool can scale to zero; a minimum of 1 sidesteps it.
- A rebuild's duration is an estimate; the Let's Encrypt count (one known use) cannot see failed orders made elsewhere.
