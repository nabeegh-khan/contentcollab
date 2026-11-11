# Demo: autoscaling, and a rollout that drops no requests

For the Wednesday 2 December demo on DOKS (advanced feature: auto-scaling and high availability, #69). The design is in [ARCHITECTURE.md D14](ARCHITECTURE.md). Every command below is run from the repository root with `kubectl` pointed at the cluster. Nothing below assumes a context name, a region or a node count: `kubectl config current-context` names the cluster, and `rollout-no-drop.sh` prints the context, the nodes and the node autoscaler's bounds as the cluster reports them before it changes anything. On 11 November the rebuilt cluster is `do-nyc3-contentcollab` (region nyc3, because tor1 had no capacity), one node pool of `s-2vcpu-4gb` with node autoscaling between 1 and 2 nodes.

**Status (11 November 2026): first live run done on the rebuilt cluster.** Results are in "Measured on the rebuilt cluster" at the end, with the raw output in `docs/evidence/2026-11-11-*`; what it did not show is under "Not yet verified".

## What the audience sees

Two things, each in one terminal pair:

1. The API starts on 2 pods. Load goes up and the HorizontalPodAutoscaler adds pods (up to 5) when average CPU passes 70% of the pods' CPU request. When the load stops, it takes the pods away again after a 5-minute window.
2. While requests keep arriving at a steady rate, the API is restarted and then rolled back. Every request is counted, and none may fail.

## Before you start

```bash
kubectl -n contentcollab get deploy,hpa,pdb,pods -l app=api    # 2 of 2 ready; the HPA shows cpu: N%/70%
node scripts/hpa-ready.mjs                                       # exits 0 only if the HPA can read CPU
kubectl get nodes -L node.kubernetes.io/instance-type            # how many nodes, of what size, right now
kubectl -n kube-system get configmap cluster-autoscaler-status -o jsonpath='{.data.status}' | grep -E 'minSize|maxSize'
kubectl top nodes                                                # memory used on each node
```

If `hpa-ready.mjs` fails, the HPA cannot scale: run `bash scripts/metrics-server.sh` first. The rollout script refuses to start unless every node it can read has room for what the run adds: the k6 pod's 512 MiB memory limit plus one more API pod during the rollout (`maxSurge` times the api container's memory limit, both read from the Deployment: 768 MiB on 11 November), measured as allocatable minus use, whatever the node count or size. A node with no metrics yet (for example one the autoscaler has just added, before metrics-server reports it) is named as not checked, and the script stops unless `ALLOW_UNCHECKED_MEMORY=1`, because the load or the surge pod could land on it. Five API pods may not fit on the nodes there are when the load starts; with node autoscaling, pods that cannot be scheduled make the autoscaler add a node; how long that takes here is not measured yet (see "Not yet verified").

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

Terminal C, the nodes, since the node autoscaler may add one during the load:

```bash
kubectl get nodes -w | while IFS= read -r l; do echo "$(date -u +%T) $l"; done | tee docs/evidence/$(date -u +%F)-nodes-watch.txt
```

Start this section with the HPA at 2 replicas (`kubectl -n contentcollab get hpa api`): section 2's load can scale it out, and it takes about 5 minutes to come back. On 11 November it was already at 5 when this section started, so the scale-out was not seen here (see the measured results). What to look for: in terminal A, `TARGETS` climbs past `70%` during the 150 req/s step and `REPLICAS` rises from 2 toward 5, in one or more steps as the HPA re-evaluates (every 15 seconds; it may add several pods at once). The load test prints a table with the replicas at the end of each step and writes `docs/loadtest/<time>.csv`, `-failures.csv` and `-scaling.csv` (HPA desired, pods created and ready every 2 seconds). On the previous cluster, on 6 November, the HPA went from 2 to 3, 4 and 5 replicas within 85 seconds of the 150 req/s step (BUILD_LOG.md, second load test).

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

The script prints the context, the nodes (count, size, allocatable memory), the node autoscaler's minimum and maximum, the strategy and the hook it is running with (`maxUnavailable` 0 and the 10-second `preStop`), the node with the least free memory, the time the rollout starts and finishes, k6's totals, and the last line `PASS: no request failed during the rollout`, or `FAIL: N of M requests failed` and exit code 1. A pass also means the Deployment really got a new revision and the load was still running when the rollout finished. To keep the output: add `| tee docs/evidence/$(date -u +%F)-rollout-restart.txt`.

What it is designed to do: new pods start beside the old ones (`maxSurge: 1`), an old pod leaves only after a new one is ready (`maxUnavailable: 0`, the readiness probe on `/health`), and a pod that is stopping keeps serving for 10 seconds while it is removed from the Service (the `preStop` sleep), then finishes its in-flight requests and exits.

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

To see what the hook changes, run section 3 (through the public URL) once before this patch and once after: on 11 November section 2, inside the cluster, dropped nothing with or without it.

## If something goes wrong

- A node has less free memory than the run can add (768 MiB on 11 November): `rollout-no-drop.sh` refuses to start and names the node and the figures. Stop other work on the cluster, or wait for the HPA to scale back to 2. `MIN_NODE_FREE_MIB` changes the threshold; lowering it below what the run adds risks evictions.
- `warning: <node>: memory not readable, not checked`: that node had no metrics, or a memory figure the script cannot read. Without `ALLOW_UNCHECKED_MEMORY=1` the run then stops before changing anything; run again once `kubectl top nodes` lists the node, or set it to go ahead without that node checked.
- `ACTION=undo` sizes the surge from the Deployment's current pod template, not the previous revision's. If the previous revision had a larger api memory limit, set `MIN_NODE_FREE_MIB` to cover it.
- Pods stuck `Pending` while scaling: the nodes are out of memory or CPU. `kubectl -n contentcollab describe pod <name>` says which. With node autoscaling, the autoscaler adds a node up to its maximum (`kubectl get nodes -w`); at the maximum, pods stay `Pending`.
- A rollout that never finishes: `kubectl -n contentcollab rollout undo deployment/api`.
- The k6 Job is removed an hour after it finishes (`ttlSecondsAfterFinished`), but its ConfigMap, which holds the k6 script, is not. After a run: `kubectl -n contentcollab delete job/k6-rollout configmap/k6-rollout --ignore-not-found`.

## Measured on the rebuilt cluster (11 November 2026)

First live run, nyc3, one `s-2vcpu-4gb` node (autoscaling 1 to 2), api image `08b479e`. Raw output in `docs/evidence/2026-11-11-*`; scaling times come from the HPA's events, saved in `2026-11-11-hpa-events.txt` (the watch file prints each change up to 15 s later, at its next sample).

| Run | Path | Replicas | Requests | Failed | Notes |
|---|---|---|---|---|---|
| Restart, before the drain (no `preStop`) | k6 Job inside the cluster, `/metrics` | 2 at the start; the HPA went to 5 during the run | 4,437 | 0 | rollout 24 s, p95 30 ms, 64 iterations dropped |
| Restart, with the drain | same | 2 at the start; the HPA went to 4 during the run | 4,501 | 0 | rollout 23 s, p95 9 ms |
| Undo, with the drain | same | 4 | 4,501 | 0 | rollout 45 s, p95 11 ms |
| Control, no rollout | laptop through the Gateway, `/health`, 50 req/s for 120 s | 4 | about 6,000 | 0 | p50 60 ms, p95 96 ms |
| Restart halfway, with the drain | same | 4 | about 6,000 | 28 (0.47%) | all `UND_ERR_SOCKET`, in four bursts 8 to 12 s apart while the four old pods were replaced |

- **Scale-out:** the k6 load inside the cluster scaled the HPA during both restart runs: 2 to 4 at 21:49:24Z and to 5 at 21:49:39Z in the first, 2 to 3 at 22:03:10Z and to 4 at 22:03:25Z in the second (the second is also in the watch file). So the stepped load test (50 then 150 req/s, 150 s each, 21:50:22 to 21:55:25) ran at 5 replicas from the start: 0 failures, p95 113 ms at both steps, HPA CPU 28 to 36% at 50 req/s after the first sample (10%, a lagging reading) and 51 to 66% at 150 req/s, never past the 70% target.
- **Scale-back:** 5 to 3 at 22:00:25Z and to 2 at 22:00:40Z, 5 minutes after the last samples that recommended 5 and 3 replicas (66% at 21:55:25, 40% at 21:55:40), as the HPA's 5-minute downscale window says.
- **Nodes:** one node throughout. Five API pods fitted beside everything else (peak 67% node memory during the stepped load; 69% with four pods and a surge pod during the public rollout run). The cluster autoscaler reported no scale-up (`2026-11-11-cluster-autoscaler-status.yaml`), so the second node was never added.
- **The drain:** inside the cluster both restarts dropped nothing, with and without the hook, so this run does not show the hook's effect on that path. Through the public URL a restart with the hook lost 28 requests where the control lost none. The two paths also differ in endpoint, replica count, client and route, so where the drops happen is not established.
- The drain was added to the live Deployment with `kubectl patch` (revision 5); it is not in the `last-applied-configuration` annotation, so a later `kubectl apply -k` (as `deploy.yml` runs) most likely leaves it in place rather than removing it; that is not checked. It stays until removed by hand or until the pull request puts it in the manifests. `kubectl rollout undo` warned that the `last-applied-configuration` annotation is not updated by a rollback.

## Not yet verified

- A scale-out from 2 to 5 under the stepped load alone (section 1 started at 5 replicas), and the cluster autoscaler adding the second node.
- A restart through the public URL without the drain, so the drain's effect on that path is not measured; why requests fail there during a rollout, and what removes those failures.
- A clean before-and-after inside the cluster: in both restart runs the HPA scaled out after the rollout finished, while the k6 load was still on (to 5 in the first, to 4 in the second); what separates them is the 64 iterations k6 could not send before the drain (4,437 of 4,501) and p95 30 ms against 9 ms.
- Memory during the rollout runs: the check sizes the room for k6 and one surge pod (768 MiB; the first run started with 773 free), but the k6 load itself scaled the HPA by up to three more API pods, which the check does not size for. It fitted (67% at the next measured peak), but no memory figure was taken during those runs.
- The undo at two replicas (it ran at four).
- The public-URL latencies include the distance from the laptop to nyc3.
