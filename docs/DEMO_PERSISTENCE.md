# Persistence demo: PostgreSQL keeps its data (#68)

The record of the restart test runs (ARCHITECTURE D15). The script is `scripts/restart-test.sh`, in PR #120 until it merges. It writes a marker row and reads it back after each event; a pass counts only if the postgres pod was really replaced, and after events 1 and 3 the running API must answer `/health` ok again with no container restart.

Events: 1. the postgres pod is deleted; 2. the API is restarted and reads the row through its own connection; 3. PostgreSQL is scaled to 0 and back to 1; 4. with `DRAIN=1` (two Ready, schedulable nodes), the node it runs on is drained.

While it runs, PostgreSQL is down during events 1 and 3: after about 15 s the API pods go unready and the site serves nothing until it is back. Not during a demo or grading.

## Runs

| Date | Where | Command | Result |
|---|---|---|---|
| not yet run | DOKS nyc3 (`do-nyc3-contentcollab`, one node) | `$env:KUBE_CONTEXT="do-nyc3-contentcollab"` then `& "C:\Program Files\Git\bin\bash.exe" scripts/restart-test.sh` (events 1 to 3) | |
| not yet run | DOKS with a second Ready node | the same with `$env:DRAIN="1"` first | |
| not yet run | local cluster, the claim replaced by an `emptyDir` | same script | must FAIL |

Each run's output goes in `docs/evidence/` with its date, and its line here gives the claim's volume name before and after, the seconds per event and the pass or fail line.
