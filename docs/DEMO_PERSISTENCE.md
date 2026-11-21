# Persistence demo: PostgreSQL keeps its data (#68)

The record of the restart test runs (ARCHITECTURE D15). The script is `scripts/restart-test.sh` (PR #120). It writes a marker row and reads it back after each event; a pass counts only if the postgres pod was really replaced, and after events 1 and 3 the running API must answer `/health` ok again with no container restart.

Events: 1. the postgres pod is deleted; 2. the API is restarted and reads the row through its own connection; 3. PostgreSQL is scaled to 0 and back to 1; 4. with `DRAIN=1` (two Ready, schedulable nodes), the node it runs on is drained.

While it runs, PostgreSQL is down during events 1 and 3: after about 15 s the API pods go unready and the site serves nothing until it is back. Not during a demo or grading.

## Runs

| Date | Where | Command | Result |
|---|---|---|---|
| 19 November 2026 | DOKS nyc3 (`do-nyc3-contentcollab`, one node) | `$env:KUBE_CONTEXT="do-nyc3-contentcollab"` then `& "C:\Program Files\Git\bin\bash.exe" scripts/restart-test.sh` (events 1 to 3) | PASS: the marker survived 3 of 3 events. Claim `pvc-6a857bd4-b129-4206-9d31-fd3827574e20` (do-block-storage); ok after deleting the postgres pod (22 s from the start), after restarting the api (52 s) and after scaling postgres to 0 and back to 1 (75 s); the API reconnected without a restart after events 1 and 3. Output: `docs/evidence/2026-11-19-restart-test.txt` |
| 20 November 2026 | DOKS nyc3, three Ready nodes | the same with `$env:DRAIN="1"` first | PASS: the marker survived 4 of 4 events. Same claim `pvc-6a857bd4-b129-4206-9d31-fd3827574e20`. Event 4 cordoned and drained `default-36811a`, where postgres had been rescheduled after event 3, and it came back on `default-368do2` (218 s from the start); the volume reattached on the other node. Output: `docs/evidence/2026-11-20-restart-test-drain.txt` |
| not yet run | local cluster, the claim replaced by an `emptyDir` | same script | must FAIL |

Each run's output goes in `docs/evidence/` with its date, and its line here gives the claim's volume name before and after, the seconds per event and the pass or fail line.

## Autoscaling run, 21 November 2026 (not a restart test; recorded beside them, #69)

The same cluster (two Ready nodes) under the stepped load: 50 then 150 requests a second, 180 s each, against `https://contentcollab.app/health`. The HPA went 2 to 3 pods at 19:09:30 UTC and 3 to 5 at 19:10:15, and all five were ready at 19:10:34. Failures: 0 at 50 req/s; 16 at 150 req/s (0.06%, p95 175 ms), all socket resets within one second at 19:10:32, just before the fifth pod became ready. Peak node memory 84%; no third node was added. Files: `docs/evidence/2026-11-21-hpa-watch.txt`, `docs/evidence/2026-11-21-api-pods-watch.txt`, `docs/loadtest/2026-11-21T19-12-52-177Z.csv` (with `-failures` and `-scaling`). Details and the 20 November attempt this replaces: ARCHITECTURE D15.
