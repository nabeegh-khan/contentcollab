# Load-test results

Output of `scripts/loadtest.mjs` (#69): one `<timestamp>.csv` per run, with `<timestamp>-failures.csv` and `<timestamp>-scaling.csv` beside it. A `-rollout` suffix marks a run with `ROLLOUT=1`.

Columns written by the current script: `target`, `sent_per_s` (the rate requests went out), `ok_per_s` (successful responses per second, which is what the API served), `p50_ms` and `p95_ms` (successful requests only), `error_pct` and `failed` (any 4xx or 5xx response, timeout or network error), `failure_reasons`, `rollout` (`complete`, or why the rollout did not finish), `peak_node_memory_pct`, `ready_replicas` (ready API pods at the end of the step) and `stopped`.

## Runs recorded before the columns changed

Both runs below are from 6 November 2026 on DOKS, made with earlier versions of the script, so their columns differ from the list above and they have no failures or scaling files:

| File | Script at | Columns |
|---|---|---|
| `2026-11-06T21-57-21-925Z.csv` | commit `d682977` | `achieved` is the rate requests were sent at, not served; latency includes failed requests; only 5xx counted as errors |
| `2026-11-06T22-17-22-033Z.csv` | commit `d7f19c0` | same as above, plus `failure_reasons` and `peak_node_memory_pct` |

Their commit messages record the HPA going from 2 to 5 replicas, but they are not the final numbers: the runs for the report are made again with the current script (#69).
