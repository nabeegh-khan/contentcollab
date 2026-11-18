# CI/CD evidence (#70, advanced feature 2)

Written Wednesday 11 November 2026 for issue [#70](https://github.com/nabeegh-khan/contentcollab/issues/70). **Status: the baseline and the failure path are shown here; the first live rollout is not, because it needs #83 merged and a cluster to roll out to (section 5).** Everything below is from `.github/workflows/deploy.yml` as it is on `main` (f8191b7).

## 1. What the pipeline does

On a push to `main` that touches `api/**`, `worker/**`, `k8s/**` or `deploy.yml`:

1. **checks** runs the same jobs as a pull request (`ci.yml`, called as a reusable workflow). The build waits for it (`needs: checks`).
2. **build** builds the api and worker images in parallel and pushes them to ghcr.io tagged with the commit SHA and `latest`, reusing layers from the last build (`cache-from: type=gha`).
3. **rollout** (one at a time, `concurrency: rollout`) saves a kubeconfig that expires after 600 seconds, pins both Deployments to the SHA in `k8s/doks`, applies once, checks each Deployment runs this commit's image, waits for `rollout status` (180 s) and runs `rollout undo` on any that never turns ready, failing the run.
4. **smoke check**, only when the repository variable `SMOKE_URL` is set: up to 12 tries, 5 seconds apart, for `"status":"ok"` from `/health`; otherwise it refreshes the kubeconfig, undoes both Deployments and fails the run.

Until the `DIGITALOCEAN_ACCESS_TOKEN` secret exists, step 3 stops green with a warning ("images pushed, cluster not changed"). The secret was set on 11 November at 16:34 UTC.

## 2. Before: build and deploy times

From the Actions API, 11 November: the eight most recent deploy runs. "Gate" is the checks job added to the front of the workflow on 10 November. Every one of these ran before the access token was set (16:34 UTC on 11 November), so each rollout step stopped at "cluster not changed" in 4 to 7 seconds.

| Run | Commit | Gate | Build api / worker | Checks (longest job) | Total |
|---|---|---|---|---|---|
| [42387590015](https://github.com/nabeegh-khan/contentcollab/actions/runs/42387590015) | a2e0795, the oldest run listed | no | 103 s / 112 s | none | 124 s |
| [42387810706](https://github.com/nabeegh-khan/contentcollab/actions/runs/42387810706) | 8f9e1e0 | no | 20 s / 29 s | none | 42 s |
| [42404815631](https://github.com/nabeegh-khan/contentcollab/actions/runs/42404815631) | 3c53210 | no | 87 s / 14 s | none | 100 s |
| [42573958709](https://github.com/nabeegh-khan/contentcollab/actions/runs/42573958709) | 521a2a3 | no | 15 s / 24 s | none | 34 s |
| [42910483610](https://github.com/nabeegh-khan/contentcollab/actions/runs/42910483610) | 3906786 | yes | 24 s / 18 s | docker 121 s | 159 s |
| [43041143341](https://github.com/nabeegh-khan/contentcollab/actions/runs/43041143341) | 13b6498 | yes | 21 s / 21 s | test 85 s | 124 s |
| [43043113204](https://github.com/nabeegh-khan/contentcollab/actions/runs/43043113204) | f88ec56 | yes | 24 s / 14 s | test 77 s | 117 s |
| [43044836675](https://github.com/nabeegh-khan/contentcollab/actions/runs/43044836675) | 2fd0603 | yes | 50 s / 27 s | test 75 s | 141 s |

What it shows: after the oldest run (103 and 112 seconds per image) builds take 14 to 50 seconds, with one 87-second api build in between (3c53210); whether that was a cache miss was not checked. The gate puts the longest check job (75 to 121 seconds) in front of the build, so a gated deploy takes 117 to 159 seconds, against 34 to 124 seconds before it. The rollout step is 4 to 7 seconds when it has nothing to do; its time against a live cluster is the first thing to record after #83 merges (section 5). There is no "after" figure for #70's timing goal yet: it needs a deploy that acts on a cluster.

## 3. Which pushes start a deploy

26 commits reached `main` after the last run above (2fd0603, 15:05 UTC) and none started a deploy: none touched `api/`, `worker/`, `k8s/` or `deploy.yml`. **One exception shows a gap against #70's "skip docs-only changes":** f88ec56, whose subject is `docs(architecture)`, edited `api/README.md` and `k8s/README.md`, which sit inside the `api/**` and `k8s/**` filters, so it ran the full deploy (run 43043113204). A markdown file inside those folders should not need a build. A negative pattern in the `paths` list (`"!**/*.md"`) would skip them; that is a change to `deploy.yml`, which #83 also edits, so it is proposed here and not made.

## 4. The failure path, executed

The rollback cannot be shown on `main` without merging a broken commit, which was ruled out, and the deploy only runs on pushes to `main`. What can be shown without touching the cluster is the workflow's own shell code failing: the two `run:` blocks were cut out of `deploy.yml` verbatim (the rollout step with `${{ github.sha }}` replaced by a fixed value, and the smoke step) and run under `bash -eo pipefail`, as the runner does, against stand-ins that only record what they are called with (`kubectl`, `kustomize`, `doctl`) and a local HTTP server for `/health`. The stand-ins are first on `PATH`, `KUBECONFIG` points nowhere, and the harness refuses to start unless each resolves to its stand-in. Nothing reached DigitalOcean.

| Case | What is made to happen | What the workflow's code did | Exit |
|---|---|---|---|
| R1 healthy rollout | both images match the commit, both `rollout status` succeed | pinned both images with `kustomize edit set image`, `kubectl apply -k k8s/doks`, checked both images, waited for both; no `undo` | 0 |
| R2 api never turns ready | `rollout status deployment/api` times out | `rollout undo deployment/api`; **then still checked and waited for the worker** | 1 |
| R3 worker runs another image | `deployment/worker` reports `:old0000` | `::error::deployment/worker runs ...:old0000, not this commit`; no `undo` (a new revision may not exist, so the workflow only reports it) | 1 |
| S1 smoke ok | `/health` answers `{"status":"ok","postgres":"ok","redis":"ok"}` | `smoke ok: {...}` on the first try; no `kubectl` or `doctl` call | 0 |
| S2 smoke fails | `/health` answers 503 `{"status":"degraded","postgres":"down","redis":"ok"}`, twelve times | `::error::Smoke check failed (last body: {"status":"degraded",...}): rolling back`; `doctl kubernetes cluster kubeconfig save --expiry-seconds 600 contentcollab`; then `rollout undo` and `rollout status` for **api and for worker**, each in turn | 1 |

By accident the first attempt at S1 ran with the server not started, which exercised a further case: with the site unreachable every try fails, and the same rollback runs for both Deployments (exit 1, the same five calls as S2).

The calls recorded in S2, in order:

```
doctl kubernetes cluster kubeconfig save --expiry-seconds 600 contentcollab
kubectl -n contentcollab rollout undo deployment/api
kubectl -n contentcollab rollout status deployment/api --timeout=180s
kubectl -n contentcollab rollout undo deployment/worker
kubectl -n contentcollab rollout status deployment/worker --timeout=180s
```

What is not proved by this: that `rollout undo` restores a working release on a real cluster, and that the 600-second credentials are accepted. Those parts are DigitalOcean's and Kubernetes's. The workflow's own decisions (when to undo, which Deployments, that the run fails, that a failed undo is reported and the other Deployment is still handled) are what was run. The shape of the rollout step is held in CI by `tests/test_k8s_deploy.py` in #83 (it reads only that step; the mutations it was checked against are in the BUILD_LOG entry of 10 November, #82, PR #83).

How to repeat it: cut a step's `run: |` body out of `deploy.yml` with `awk` (`index($0, "- name: <step name>")`, then the first `run: |` line, then lines until the next line starting with six spaces and `- ` or `#`, removing ten leading spaces), put recording stand-ins named `kubectl`, `kustomize` and `doctl` first on `PATH`, set `REGISTRY`, `GITHUB_STEP_SUMMARY` and (for the smoke step) `SMOKE_URL`, and run it with `bash -eo pipefail`. The stand-in `kubectl` answers `get deployment/<svc> -o jsonpath=...` with the image for the commit (or an older one for R3), fails `rollout status deployment/<svc>` for the service named in a variable (R2) and appends every call to a log.

## 5. Not shown yet, and what to record when it is

1. **Merge #83, then #99** (`gh pr merge <n> -R nabeegh-khan/contentcollab --squash --admin --delete-branch`, #83 first). Both are updated with `main` and green on 11 November (runs [43079785532](https://github.com/nabeegh-khan/contentcollab/actions/runs/43079785532) and [43079788625](https://github.com/nabeegh-khan/contentcollab/actions/runs/43079788625)). Merging #83 changes `k8s/**`, so it starts the first deploy that acts on a cluster, to the cluster named `contentcollab`: do it when that cluster is the one to keep. The cluster is still the original one (created 4 November, high-availability control plane); a rebuild is pending (COST_PLAN.md), and a deploy to the old cluster would be replaced by the rebuild's own pin.
2. **Set `SMOKE_URL`** (`gh variable set SMOKE_URL --body https://contentcollab.app -R nabeegh-khan/contentcollab`) only when `https://contentcollab.app/health` answers ok on the cluster that is meant to stay up: the variable makes every later deploy roll back if it does not. It answered `{"status":"ok","postgres":"ok","redis":"ok"}` on 11 November.
3. **Record from the first live run:** the run URL; the build, rollout and smoke step times; the image tag `kubectl -n contentcollab get deployment -o wide` then shows; the smoke step's `smoke ok:` line.
4. **The rollback on a real cluster** needs a release that starts and does not serve `/health`. It cannot be on `main` without being a real regression; the options are a dry run of the pinned manifests against a throwaway cluster, or accepting section 4 as the evidence.
5. **Section 3's gap:** add `"!**/*.md"` to the `paths` filter, with a test, after #83 merges.
