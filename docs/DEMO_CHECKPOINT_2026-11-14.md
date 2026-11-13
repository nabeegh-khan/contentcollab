# Checkpoint demo, Saturday 14 November 2026, 3:30pm: five minutes

Written Friday 13 November, evening, from `main` (cf483ef: #83, #99 and #88 merged), the open pull requests and the cluster. Commands are for Windows PowerShell 5.1, kube context `do-nyc3-contentcollab`. Re-check each "pending" row on the day: it becomes live only when its pull request is merged.

## What runs live today

| What | Show it with | Evidence |
|---|---|---|
| The app on DOKS behind the Gateway with TLS; API, worker, Redis, PostgreSQL on a volume | `curl.exe -s https://contentcollab.app/health` (expect `{"status":"ok","postgres":"ok","redis":"ok"}`); `kubectl -n contentcollab get pods,pvc,hpa` | ARCHITECTURE D13 (nyc3 rebuild) |
| Deploy on merge: checks, build, image pinned to the commit, rollout, smoke check, undo on failure | [Run 43518794078](https://github.com/nabeegh-khan/contentcollab/actions/runs/43518794078) (merge of #83, 13 Nov): both rollouts, then `smoke ok` | `docs/evidence/ci-cd.md` (the rollback logic run against stand-ins; not exercised on the cluster) |
| CI runs the migrations up, down and up before the tests (#99) | The `test` job's "Migrations up, down, up" step on any API pull request | Run 43520737569: `main` plus #88, "Migrations complete!" after up, down and up, all 7 CI jobs green |
| Autoscaling: HPA 2 to 5 on CPU, rollout under load | `kubectl -n contentcollab get hpa api`; the numbers, not a live load (it takes minutes) | `docs/DEMO_SCALING.md`, measured 11 Nov: the HPA went 2 to 5 under the rollout check's in-cluster load (21:49Z), the stepped load (50 then 150 req/s) then ran at five pods with 0 failures, and it was back to 2 at 22:00Z, five minutes after that load ended |

## What becomes live as each pull request merges

| Pull request | Becomes live | Show it with |
|---|---|---|
| #118 migration Job (#88 merged) | Tables on the cluster's PostgreSQL, created by `db-migrate-<sha>` before the rollout | The deploy run's "Migrate the database to this commit" step (`condition met`); `kubectl -n contentcollab get jobs` |
| #111 auth (after its changes and an update from `main`) | Register and log in through the public URL | `Invoke-RestMethod -Method Post -Uri https://contentcollab.app/api/v1/auth/register -ContentType application/json -Body '{"email":"demo@example.com","password":"demo-pass-1","displayName":"Demo"}'` then the same with `/auth/login` and `{"email":...,"password":...}`; the reply has `token` |
| #116 documents and versions (needs the `reverted_from` migration and the Spaces key, #53) | Upload, list, download, new version, revert | `curl.exe -s -H "Authorization: Bearer $t" -F "file=@sample.pdf" -F "title=Demo" https://contentcollab.app/api/v1/documents` (`$t = (Invoke-RestMethod -Method Post -Uri https://contentcollab.app/api/v1/auth/login -ContentType application/json -Body '{"email":"demo@example.com","password":"demo-pass-1"}').token`) |
| #114 shares | Share by user and by link with expiry | `POST /api/v1/documents/<id>/shares` with `{"email":...,"role":"viewer"}` (`docs/API.md`) |
| #86 web skeleton, #93 pages | The browser client, locally first | `docker compose up --build web`, then http://localhost:8080 |

As of 13 Nov evening: #88 is merged; #118 is green and awaiting review; #85 is approved by Nabeegh with Eyrika's 12 Nov changes-requested review still standing; #111, #114, #116 and #86 have changes requested.

## Order, five minutes

1. (1 min) `/health` on the public URL and `kubectl get pods,pvc,hpa`: what runs where, PostgreSQL on a block-storage volume.
2. (1 min) The #83 deploy run: commit pinned, both rollouts, `smoke ok`; the undo logic and how it was tested (stand-ins) in `ci-cd.md`.
3. (1 min) The migrations in CI (#99) and, if #118 is merged, the migrate step in the deploy run and the tables on the cluster.
4. (1 min) Scaling numbers from `DEMO_SCALING.md`, `get hpa api` live.
5. (1 min) Whatever API route is merged by then (auth first); otherwise the open pull requests, their review state, and the dates the team sets at this call.

Not shown: the restart test on DOKS (#68) unless it was run before the call (its record goes in `docs/DEMO_PERSISTENCE.md`); Prometheus and Grafana (#112, not installed); live load (too long for the slot).
