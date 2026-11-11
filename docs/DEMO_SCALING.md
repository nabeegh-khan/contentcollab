# Demo: autoscaling, and a rollout that drops no requests

For the Wednesday 2 December demo on DOKS (advanced feature: auto-scaling and high availability, #69). The design is in [ARCHITECTURE.md D14](ARCHITECTURE.md). Every command below is run from the repository root with `kubectl` pointed at the cluster (`kubectl config current-context` says `do-tor1-contentcollab`).

**Status (11 November 2026): none of this has been run on the rebuilt cluster.** The old cluster was deleted on 11 November for the rebuild, and the new one was not up when this was written. The outputs described are the shape the scripts print, taken from their tests and from the scripts themselves, not measured on DOKS. Measured results go to `docs/evidence/` and BUILD_LOG.md after the first live run, and this page is updated with them. See "Not yet verified" at the end.

## What the audience sees

Two things, each in one terminal pair:

1. The API starts on 2 pods. Load goes up and the HorizontalPodAutoscaler adds pods (up to 5) when average CPU passes 70% of the pods' CPU request. When the load stops, it takes the pods away again after a 5-minute window.
2. While requests keep arriving at a steady rate, the API is restarted and then rolled back. Every request is counted, and none may fail.

## Before you start

```bash
kubectl -n contentcollab get deploy,hpa,pdb,pods -l app=api    # 2 of 2 ready; the HPA shows cpu: N%/70%
node scripts/hpa-ready.mjs                                       # exits 0 only if the HPA can read CPU
kubectl top nodes                                                # both nodes under 85% memory (the rollout script refuses above 90%)
```

If `hpa-ready.mjs` fails, the HPA cannot scale: run `bash scripts/metrics-server.sh` first. If a node is above 85% memory, do not start: five API pods plus the load generator may not fit on two 2 GB nodes (see "Not yet verified").

## 1. Scale out and back

Terminal A, the autoscaler (each line stamped with the time, and saved):

```bash
mkdir -p docs/evidence
kubectl -n contentcollab get hpa api -w | while IFS= read -r l; do echo "$(date -u +%T) $l"; done | tee docs/evidence/$(date -u +%F)-hpa-watch.txt
```

Terminal B, the load, against the public URL (about 5 minutes; at 150 requests a second):

```bash
BASE=https://contentcollab.app STEPS=50,150 STEP_SECONDS=150 node scripts/loadtest.mjs
```

From PowerShell: `$env:BASE='https://contentcollab.app'; $env:STEPS='50,150'; $env:STEP_SECONDS='150'; node scripts/loadtest.mjs`.

What to look for: in terminal A, `TARGETS` climbs past `70%` during the 150 req/s step and `REPLICAS` goes from 2 up to 3, 4 and possibly 5, one step each time the HPA re-evaluates (every 15 seconds). The load test prints a table with the replicas at the end of each step and writes `docs/loadtest/<time>.csv`, `-failures.csv` and `-scaling.csv` (HPA desired, pods created and ready every 2 seconds). On the previous cluster, on 6 November, the HPA went from 2 to 3, 4 and 5 replicas within 85 seconds of the 150 req/s step (BUILD_LOG.md, second load test).

Scaling back down is slow on purpose: the HPA uses the highest recommendation of the last 5 minutes. Leave terminal A running for about 7 minutes after the load ends and `REPLICAS` returns to 2. For the live demo, show the saved watch file for this part instead of waiting.

## 2. A rollout under load, and a rollback

Terminal A, the pods changing:

```bash
kubectl -n contentcollab get pods -l app=api -w
```

Terminal B:

```bash
bash scripts/rollout-no-drop.sh                  # restart the API under 50 requests a second for 90 s
ACTION=undo bash scripts/rollout-no-drop.sh      # roll it back under the same load
```

(From PowerShell: `& 'C:\Program Files\Git\bin\bash.exe' scripts/rollout-no-drop.sh`; plain `bash` there is WSL.)

The script prints the strategy and the hook it is running with (`maxUnavailable` 0 and the 10-second `preStop`), the highest node memory, the time the rollout starts and finishes, k6's totals, and the last line `PASS: no request failed during the rollout`, or `FAIL: N of M requests failed` and exit code 1. A pass also means the Deployment really got a new revision and the load was still running when the rollout finished. To keep the output: add `| tee docs/evidence/$(date -u +%F)-rollout-restart.txt`.

What it shows: new pods start beside the old ones (`maxSurge: 1`), an old pod leaves only after a new one is ready (`maxUnavailable: 0`, the readiness probe on `/health`), and a pod that is stopping keeps serving for 10 seconds while it is removed from the Service (the `preStop` sleep), then finishes its in-flight requests and exits.

The load goes to the API Service's `/metrics`, inside the cluster. `/health` is not used for the count because it answers 503 whenever PostgreSQL or Redis misses a check, and the Redis ping gives up after 500 ms, so it can fail under load with no rollout at all (D14).

## 3. The same through the public URL

This sends the load through the Gateway, as a user's browser would. The Gateway routes only `/api`, `/socket.io` and `/health`, so this run uses `/health`, and it needs a control with no rollout beside it:

```bash
# control: the same load, no rollout
BASE=https://contentcollab.app SKIP_HPA_CHECK=1 STEPS=50 STEP_SECONDS=120 node scripts/loadtest.mjs
# the rollout, halfway through the same load
BASE=https://contentcollab.app ROLLOUT=1 SKIP_HPA_CHECK=1 STEPS=50 STEP_SECONDS=120 node scripts/loadtest.mjs
```

Read the rollout run's failed count against the control's. `loadtest.mjs` restarts the Deployment halfway, exits 1 if the restart fails or does not finish inside the step, and records each failed request's time and reason in `-failures.csv`, which can be lined up with the pod changes in `-scaling.csv`.

## The drain before it is in `main`

The `preStop` hook is in `k8s/components/graceful-drain` and reaches the cluster when the pull request that adds it is merged and `deploy.yml` rolls out. Until then, add it to the running Deployment on its own (not `kubectl apply -k k8s/doks`, which would reset the pinned image tags):

```bash
kubectl -n contentcollab patch deployment api --type=strategic --patch-file k8s/components/graceful-drain/api-prestop.yaml
kubectl -n contentcollab rollout status deployment/api
```

To see what the hook changes, run section 2 once before this patch and once after.

## If something goes wrong

- A node is above 90% memory: `rollout-no-drop.sh` refuses to start. Stop other work on the cluster, or lower `RATE`.
- Pods stuck `Pending` while scaling: the nodes are out of memory or CPU. `kubectl -n contentcollab describe pod <name>` says which. The HPA maximum of 5 may be more than two small nodes hold.
- A rollout that never finishes: `kubectl -n contentcollab rollout undo deployment/api`.
- The k6 Job is removed an hour after it finishes (`ttlSecondsAfterFinished`), but its ConfigMap, which holds the k6 script, is not. After a run: `kubectl -n contentcollab delete job/k6-rollout configmap/k6-rollout --ignore-not-found`.

## Not yet verified (first live run)

- Nothing here has been run on the rebuilt cluster. The cluster did not exist when this page was written: the old one was deleted for the rebuild on 11 November and the first attempt to create the new one failed for capacity in tor1, so the node size, and possibly the region, of the cluster that finally exists are not known yet.
- The create command that failed asked for node autoscaling (2 to 3 nodes). If the new cluster has it, API pods that cannot be scheduled may add a node during the scale-out (watch `kubectl get nodes` in a third terminal), which changes both the replicas reached and the cost.
- The output shapes come from the scripts and their stub tests. The numbers (replicas reached, time to scale, requests counted, failures) are not measured yet.
- Whether five API pods fit in memory beside the other workloads. Before the rebuild the two nodes sat at 77 and 83% memory with two API pods, and on 6 November one node reached 89% with five.
- Whether `/health` fails under load on DOKS with no rollout (a local run saw 1 failure in 4,501 requests), and how many requests fail through the Gateway during a rollout, with and without the drain.
- Time to scale back to 2 after the load ends (the 5-minute window is from the Kubernetes docs, not yet seen here).
- The drain patch has been checked only offline (`kubectl patch --local` on the rendered Deployment), not on a live Deployment.
