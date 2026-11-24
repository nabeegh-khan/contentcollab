# CI/CD evidence (#70, advanced feature 2)

Written Wednesday 11 November 2026 for issue [#70](https://github.com/nabeegh-khan/contentcollab/issues/70). **Status (updated 23 November: the first live rollback is in section 6; the smoke-check rollback is still not shown). Original status of 11 November: the baseline and the failure path are shown here; the first live rollout is not, because it needs #83 merged and a cluster to roll out to (section 5).** Everything below is from `.github/workflows/deploy.yml` as it is on `main` (f8191b7).

## 1. What the pipeline does

On a push to `main` that touches `api/**`, `worker/**`, `k8s/**` or `deploy.yml`:

1. **checks** runs the same jobs as a pull request (`ci.yml`, called as a reusable workflow). The build waits for it (`needs: checks`).
2. **build** builds the api and worker images in parallel and pushes them to ghcr.io tagged with the commit SHA and `latest`, reusing layers from the last build (`cache-from: type=gha`).
3. **rollout** (one at a time, `concurrency: rollout`) saves a kubeconfig that expires after 600 seconds, pins both Deployments to the SHA in `k8s/doks`, applies once, checks each Deployment runs this commit's image, waits for `rollout status` (180 s on 11 November; 120 s per Deployment now, `deploy.yml`) and runs `rollout undo` on any that never turns ready, failing the run.
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

**What `rollout undo` does to the schema (#105, ARCHITECTURE D24).** Nothing: it brings back the previous image, and the migration Job's changes stay. The previous release keeps working on the newer schema because a migration's `up` only adds within a release; `scripts/migration-compat.mjs` fails CI on a drop or rename in `up` without a `contract:` marker. A release whose migration carries a marker removed something an older version reads, so undoing past it needs that migration's `down` run by hand first, in an API pod. node-pg-migrate reads `DATABASE_URL` or the `PG*` variables, while the API pod has `DB_*` from `app-config` and `app-secrets`, so they are mapped in the command (as `k8s/doks/migrate-job.yaml` does for `up`): `kubectl -n contentcollab exec deploy/api -- sh -c 'PGHOST=$DB_HOST PGPORT=$DB_PORT PGDATABASE=$DB_NAME PGUSER=$DB_USER PGPASSWORD=$DB_PASSWORD npm run migrate -- down 1'` (one migration; the count is explicit; the single quotes keep the variables for the pod's shell). `down` drops what `up` added, including any data written into it since, so check that first.

What is not proved by this: that `rollout undo` restores a working release on a real cluster, and that the 600-second credentials are accepted. Those parts are DigitalOcean's and Kubernetes's. The workflow's own decisions (when to undo, which Deployments, that the run fails, that a failed undo is reported and the other Deployment is still handled) are what was run. The shape of the rollout step is held in CI by `tests/test_k8s_deploy.py` in #83 (it reads only that step; the mutations it was checked against are in the BUILD_LOG entry of 10 November, #82, PR #83).

**Changed on 18 November (ARCHITECTURE D25, #108).** The rows above record the 11 November workflow. Since #108: each Deployment's revision is recorded before the apply, and only a Deployment whose revision moved in this run is undone (by either step), so a re-run of the same commit undoes nothing and fails with `not changed by this run`; when one Deployment fails, every Deployment this run changed is undone, so R2 now ends with both the api and the worker undone; a failed `kubectl apply` is reported and the watch still runs; a revision that cannot be read is reported as unreadable rather than undone blind; the rollout step renews the login before its final undo. `tests/test_deploy_undo.py` runs both steps against stand-ins for these cases on every pull request (20 tests).

How to repeat it: cut a step's `run: |` body out of `deploy.yml` with `awk` (`index($0, "- name: <step name>")`, then the first `run: |` line, then lines until the next line starting with six spaces and `- ` or `#`, removing ten leading spaces), put recording stand-ins named `kubectl`, `kustomize` and `doctl` first on `PATH`, set `REGISTRY`, `GITHUB_STEP_SUMMARY` and (for the smoke step) `SMOKE_URL`, and run it with `bash -e` (how GitHub runs a step that sets no `shell:`). The stand-in `kubectl` answers `get deployment/<svc> -o jsonpath=...` with the image for the commit (or an older one for R3), fails `rollout status deployment/<svc>` for the service named in a variable (R2) and appends every call to a log.

## 5. Not shown yet, and what to record when it is

1. **Merge #83, then #99** (`gh pr merge <n> -R nabeegh-khan/contentcollab --squash --admin --delete-branch`, #83 first). Both are updated with `main` and green on 11 November (runs [43079785532](https://github.com/nabeegh-khan/contentcollab/actions/runs/43079785532) and [43079788625](https://github.com/nabeegh-khan/contentcollab/actions/runs/43079788625)). Merging #83 changes `k8s/**`, so it starts the first deploy that acts on a cluster, to the cluster named `contentcollab`: do it when that cluster is the one to keep. The cluster is still the original one (created 4 November, high-availability control plane); a rebuild is pending (COST_PLAN.md), and a deploy to the old cluster would be replaced by the rebuild's own pin.
2. **Set `SMOKE_URL`** (`gh variable set SMOKE_URL --body https://contentcollab.app -R nabeegh-khan/contentcollab`) only when `https://contentcollab.app/health` answers ok on the cluster that is meant to stay up: the variable makes every later deploy roll back if it does not. It answered `{"status":"ok","postgres":"ok","redis":"ok"}` on 11 November.
3. **Record from the first live run:** the run URL; the build, rollout and smoke step times; the image tag `kubectl -n contentcollab get deployment -o wide` then shows; the smoke step's `smoke ok:` line. **Recorded 18 November:** eight deploys ran on the cluster that day, all green, with `SMOKE_URL` set (runs 44378773519 to 44400512360, one per merge of #111, #95, #103, #124, #102, #126, #123, #125). The last, [44400512360](https://github.com/nabeegh-khan/contentcollab/actions/runs/44400512360) for d53644f, took about 4 minutes from start to end (21:20:50 to 21:24:48 UTC): checks 66 s, image builds 45 s (api) and 109 s (worker) in parallel, rollout job 52 s (migration Job 10 s, rolling both Deployments 30 s, smoke check under 1 s, which printed `smoke ok: {"status":"ok","postgres":"ok","redis":"ok"}`). Afterwards `kubectl -n contentcollab get deployment` showed `contentcollab-api:d53644f1a125...` (2 ready) and `contentcollab-worker:d53644f1a125...` (1 ready). Times from the Actions API (`gh run view --json jobs`), read the same evening.
4. **(Rollout rollback: done 23 November, section 6; smoke-check rollback: still to do, plan on issue #70.) The rollback on a real cluster** needs a release that starts and does not serve `/health`. It cannot be on `main` without being a real regression; the options are a dry run of the pinned manifests against a throwaway cluster, or accepting section 4 as the evidence.
5. **Section 3's gap:** add `"!**/*.md"` to the `paths` filter, with a test, after #83 merges. Done in #108 (18 November); the first README-only push after it merges should start no deploy run.

## 6. After: build and deploy times, and the first live rollbacks (23 November)

From the Actions API on 23 November: the eight most recent successful deploy runs, which now include the migration Job, the apply and the rollout wait on the live cluster (the section 2 runs stopped at "cluster not changed" in 4 to 7 seconds).

| Run | Commit | Longest check job | Builds (api / worker / web) | Rollout job (migrate, apply, wait, smoke) | Total | Started (UTC) |
|---|---|---|---|---|---|---|
| [45288563346](https://github.com/nabeegh-khan/contentcollab/actions/runs/45288563346) | 2dc59ae | 74 s | 43 s / 22 s / 34 s | 56 s | 184 s | 2026-11-23T23:24:40Z |
| [45287599402](https://github.com/nabeegh-khan/contentcollab/actions/runs/45287599402) | b02d287 | 100 s | 15 s / 19 s / 18 s | 58 s | 188 s | 2026-11-23T23:18:07Z |
| [45282071382](https://github.com/nabeegh-khan/contentcollab/actions/runs/45282071382) | 042f43f | 96 s | 37 s / 21 s / 26 s | 53 s | 196 s | 2026-11-23T22:41:32Z |
| [45089361490](https://github.com/nabeegh-khan/contentcollab/actions/runs/45089361490) | a3aa4fc | 62 s | 24 s / 16 s / 21 s | 56 s | 151 s | 2026-11-23T00:32:20Z |
| [45088934819](https://github.com/nabeegh-khan/contentcollab/actions/runs/45088934819) | 8829fda | 75 s | 18 s / 18 s / 17 s | 59 s | 163 s | 2026-11-23T00:28:00Z |
| [45086663960](https://github.com/nabeegh-khan/contentcollab/actions/runs/45086663960) | dd084fd | 56 s | 21 s / 19 s / 17 s | 51 s | 138 s | 2026-11-23T00:04:58Z |
| [45080446496](https://github.com/nabeegh-khan/contentcollab/actions/runs/45080446496) | ae04b08 | 61 s | 16 s / 15 s / 16 s | 57 s | 142 s | 2026-11-22T22:56:06Z |
| [44956163407](https://github.com/nabeegh-khan/contentcollab/actions/runs/44956163407) | 29956b3 | 61 s | 52 s / 21 s / 13 s | 45 s | 167 s | 2026-11-21T22:19:41Z |

What it shows: a gated deploy takes 138 to 196 seconds in total (section 2: 117 to 159 seconds without a cluster to roll out to). The longest check job is 56 to 100 seconds, each image build 13 to 52 seconds, and the rollout job 45 to 59 seconds. The difference to the "before" runs is the rollout job, which now does real work (a migration Job, an apply, and a wait for three Deployments). Markdown-only pushes start no deploy (section 3; checked again on 23 November: the documentation commits of that day started no run).

**A failed rollout, live.** Run 45286454462 (a deliberately broken web config, PRs #168 and #169): the web rollout never turned ready, `rollout status` timed out after 120 seconds, the gate undid web, api and worker, and the run failed, while the two old web pods kept serving; the full timeline is in `docs/evidence/2026-11-23-rollback.txt`.

**Not shown live:** the smoke-check rollback (step 4 of section 1). In run 45286454462 the smoke step was skipped, because the rollout step had already failed. Showing it needs a release whose pods turn ready but whose `/health` is not `"status":"ok"`; the plan is on issue #70.
