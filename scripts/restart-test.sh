#!/usr/bin/env bash
# The restart test (#68; DB-2, TST-4): write a marker row to PostgreSQL, then show it is still there after
# each event that must not lose data:
#   1. the postgres pod is deleted and the StatefulSet replaces it
#   2. the api Deployment is restarted, and an API pod reads the row through its own connection
#   3. PostgreSQL is scaled to 0 and back to 1
#   4. with DRAIN=1 (two Ready nodes or more): the node postgres runs on is drained
# A pass is only counted if the pod really was replaced (its UID changed). After events 1 and 3 the running
# API must answer /health ok again with no container restart: it reconnects on its own (#68).
# Run it against a cluster you name: KUBE_CONTEXT is required, the current context is never assumed. It
# writes one small table, restart_test, and leaves it (DB-12: dropping data is a deliberate step; remove
# it with DROP TABLE restart_test). With DRAIN=1 it cordons and drains a node and uncordons it again, also
# on failure.
# What users see: PostgreSQL is down during events 1 and 3 (and moves node in 4, with its volume); after
# about 15 s the API's readiness probe takes its pods out, so the site serves nothing until PostgreSQL is
# back. A drain evicts every pod on that node, in every namespace, and deletes their emptyDir data. Not
# during a demo or a grading window.
#
#   KUBE_CONTEXT=<cluster> scripts/restart-test.sh            # events 1 to 3
#   KUBE_CONTEXT=<cluster> DRAIN=1 scripts/restart-test.sh    # events 1 to 4
# Settings: NAMESPACE (contentcollab), TIMEOUT (180s, per kubectl wait), RETRY_WAIT (seconds between tries, 2).
set -euo pipefail

: "${KUBE_CONTEXT:?set KUBE_CONTEXT to the cluster to test (kubectl config get-contexts)}"
: "${NAMESPACE:=contentcollab}"
: "${DRAIN:=}"
: "${TIMEOUT:=180s}"
: "${RETRY_WAIT:=2}"
[[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || { echo "NAMESPACE must be a Kubernetes name (lower-case letters, digits, - and .)"; exit 1; }
command -v kubectl >/dev/null || { echo "missing: kubectl"; exit 1; }

kc() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }
marker="restart-test-$(date +%s)-$$"   # letters, digits and dashes only: it goes into SQL
passed=0
planned=3; [ "$DRAIN" = 1 ] && planned=4
cordoned=""

fail() { echo "FAIL: $1"; exit 1; }
uncordon_on_exit() { if [ -n "$cordoned" ]; then kubectl --context "$KUBE_CONTEXT" uncordon "$cordoned" >/dev/null || echo "could not uncordon $cordoned: kubectl uncordon $cordoned"; fi; }
trap uncordon_on_exit EXIT

# psql inside the postgres pod, with the role and database the pod itself was started with
# shellcheck disable=SC2016  # the single-quoted code runs inside the pod, where $POSTGRES_USER is set
psql_in_pod() { kc exec postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -c "$1"' _ "$1"; }
# The same question asked by an API pod, through its own DB_* settings and the pg driver it ships with
# shellcheck disable=SC2016  # JavaScript for node inside the API pod
count_via_api() {
  kc exec deploy/api -- node -e 'const {Pool}=require("pg");const p=new Pool({host:process.env.DB_HOST,port:+process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});p.query("SELECT count(*)::int AS n FROM restart_test WHERE marker=$1",[process.argv[1]]).then(r=>{console.log(r.rows[0].n);return p.end()}).catch(e=>{console.error(e.message);process.exit(e.message.includes("does not exist")?3:1)})' "$marker"
}
count_via_psql() { psql_in_pod "SELECT count(*) FROM restart_test WHERE marker='$marker'"; }

# count <reader>: the number of rows with the marker. A missing table is a count of 0 (the data is gone);
# any other error means PostgreSQL is not answering yet, so try again
count() {
  local out status
  for _ in $(seq 1 30); do
    status=0; out=$("$1" 2>&1) || status=$?
    if [ "$status" = 0 ] && [[ "$out" =~ ^[0-9]+$ ]]; then echo "$out"; return 0; fi
    if [[ "$out" == *"does not exist"* ]]; then echo 0; return 0; fi
    sleep "$RETRY_WAIT"
  done
  echo "no answer: $out" >&2; return 1
}

wait_ready() { # the pod may not exist yet right after a delete or a scale up
  for _ in $(seq 1 60); do
    kc wait --for=condition=Ready pod/postgres-0 --timeout=5s >/dev/null 2>&1 && return 0
    sleep "$RETRY_WAIT"
  done
  fail "postgres-0 was not Ready within the wait"
}
uid() { kc get pod postgres-0 -o jsonpath='{.metadata.uid}'; }

# The sum of the restart counts of the running API containers
api_restarts() {
  local sum=0 n
  for n in $(kc get pods -l app=api -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.restartCount}{" "}{end}{end}'); do
    sum=$((sum + n))
  done
  echo "$sum"
}
# api_recovered <event text> <restart sum before>: the running API answers /health ok again, and no API
# container was restarted to get there
api_recovered() {
  local code=""
  for _ in $(seq 1 60); do
    # shellcheck disable=SC2016  # JavaScript for node inside the API pod
    code=$(kc exec deploy/api -- node -e 'fetch("http://localhost:3000/health").then(r=>console.log(r.status)).catch(()=>console.log(0))' 2>/dev/null) || code=""
    [ "$code" = 200 ] && break
    sleep "$RETRY_WAIT"
  done
  [ "$code" = 200 ] || fail "the API did not answer /health ok $1 (last: ${code:-no answer})"
  [ "$(api_restarts)" = "$2" ] || fail "an API container restarted $1: it did not reconnect on its own"
  echo "ok    the API reconnected $1 without a restart"
}

# check <event text> <reader>: the marker is there once
check() {
  local n
  n=$(count "$2") || fail "no answer from PostgreSQL $1"
  [ "$n" = 1 ] || fail "marker missing $1 (found $n)"
  passed=$((passed + 1))
  echo "ok    $1 (${SECONDS}s since start)"
}
replaced() { # replaced <old uid> <what happened>
  local now; now=$(uid)
  [ "$now" != "$1" ] || fail "postgres-0 was not replaced $2 (same UID $now): this proves nothing"
}

# --- start --------------------------------------------------------------------------------------
echo "Target: context $KUBE_CONTEXT, namespace $NAMESPACE, marker $marker"
if [ "$DRAIN" = 1 ]; then # refuse before anything is touched: a drain with one node leaves the pod nowhere to go
  # Only Ready nodes that take pods count: "<name> <unschedulable>|<Ready status>" per node
  nodes=$(kubectl --context "$KUBE_CONTEXT" get nodes -o jsonpath='{range .items[*]}{.metadata.name} {.spec.unschedulable}|{range .status.conditions[?(@.type=="Ready")]}{.status}{end}{"\n"}{end}' \
    | grep -c ' |True$' || true)
  if [ "$nodes" -lt 2 ]; then echo "DRAIN=1 needs at least two nodes that are Ready and schedulable (found $nodes)"; exit 1; fi
fi
echo "Claim: $(kc get pvc data-postgres-0 -o jsonpath='{.spec.volumeName} {.spec.storageClassName}')"
wait_ready
psql_in_pod "CREATE TABLE IF NOT EXISTS restart_test (id serial PRIMARY KEY, marker text NOT NULL UNIQUE, written_at timestamptz NOT NULL DEFAULT now())" >/dev/null
psql_in_pod "INSERT INTO restart_test (marker) VALUES ('$marker')" >/dev/null
[ "$(count count_via_psql)" = 1 ] || fail "the marker was not written"
echo "wrote marker; node: $(kc get pod postgres-0 -o jsonpath='{.spec.nodeName}')"

# --- 1. delete the pod ---------------------------------------------------------------------------
before=$(uid)
restarts=$(api_restarts)
kc delete pod postgres-0 --wait=true >/dev/null
wait_ready
replaced "$before" "after the delete"
check "after deleting the postgres pod" count_via_psql
api_recovered "after deleting the postgres pod" "$restarts"

# --- 2. restart the api ----------------------------------------------------------------------------
kc rollout restart deployment/api >/dev/null
kc rollout status deployment/api --timeout="$TIMEOUT" >/dev/null
check "after restarting the api, read by an API pod" count_via_api

# --- 3. scale postgres to 0 and back to 1 ------------------------------------------------------------
before=$(uid)
restarts=$(api_restarts) # the pods from the restart in event 2
kc scale statefulset postgres --replicas=0 >/dev/null
kc wait --for=delete pod/postgres-0 --timeout="$TIMEOUT" >/dev/null
kc scale statefulset postgres --replicas=1 >/dev/null
wait_ready
replaced "$before" "after scaling to 0 and back"
check "after scaling postgres to 0 and back to 1" count_via_psql
api_recovered "after scaling postgres to 0 and back to 1" "$restarts"

# --- 4. drain the node (DOKS demo) -------------------------------------------------------------------------
if [ "$DRAIN" = 1 ]; then
  before=$(uid)
  node=$(kc get pod postgres-0 -o jsonpath='{.spec.nodeName}')
  cordoned=$node # set first: an interrupt during the cordon still uncordons (a no-op if it never applied)
  kubectl --context "$KUBE_CONTEXT" cordon "$node" >/dev/null
  kubectl --context "$KUBE_CONTEXT" drain "$node" --ignore-daemonsets --delete-emptydir-data --timeout="$TIMEOUT" >/dev/null
  wait_ready
  replaced "$before" "after the drain"
  check "after draining $node (now on $(kc get pod postgres-0 -o jsonpath='{.spec.nodeName}'))" count_via_psql
fi

echo "PASS: the marker survived $passed of $planned events"
