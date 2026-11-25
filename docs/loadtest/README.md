# Load-test results

Output of `scripts/loadtest.mjs` (#69): one `<timestamp>.csv` per run, with `<timestamp>-failures.csv` and `<timestamp>-scaling.csv` beside it. A `-rollout` suffix marks a run with `ROLLOUT=1`.

Columns written by the current script: `target`, `sent_per_s` (the rate requests went out), `ok_per_s` (successful responses per second, which is what the API served; both rates are counted over the step's send window), `p50_ms` and `p95_ms` (successful requests only; `-` when none succeeded), `error_pct` and `failed` (any 4xx or 5xx response, timeout or network error), `failure_reasons`, `rollout` (`complete` when the rollout finished before the step's load stopped, or why it did not), `peak_node_memory_pct`, `ready_replicas` (ready API pods at the end of the step) and `stopped`. The script exits 1 when a rollout did not complete or the memory guard stopped the run.

## Runs recorded before the columns changed

Both runs below are from 6 November 2026 on DOKS, made with earlier versions of the script, so their columns differ from the list above and they have no failures or scaling files:

| File | Script at | Columns |
|---|---|---|
| `2026-11-06T21-57-21-925Z.csv` | commit `d682977` | `achieved` is the rate requests were sent at, not served; latency includes failed requests; only 5xx counted as errors |
| `2026-11-06T22-17-22-033Z.csv` | commit `d7f19c0` | same as above, plus `failure_reasons` and `peak_node_memory_pct` |

Their commit messages record the HPA going from 2 to 5 replicas, but they are not the final numbers: the runs for the report are made again with the current script (#69).

## 25 November 2026 (issue #184)

`2026-11-25T15-25-15-551Z`, `2026-11-25T15-32-17-745Z` and `2026-11-25T15-50-11-401Z` (each with `-failures` and `-scaling`) are laptop runs of the 150 req/s question; `2026-11-25-incluster-run1-nginx-node.txt`, `-run2-nginx-node.txt` and `-run4-other-node.txt` are the printed output of the same script run in a Job inside the cluster, with its CSVs. Runs 1 and 2 shared a node with the Gateway and are confounded; run 4 is the clean in-cluster run. What each shows: `docs/evidence/2026-11-25-load-regression.txt`.
