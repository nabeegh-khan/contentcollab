#!/usr/bin/env bash
# Rolling restart (or undo) of the API under steady load; exits 1 if any
# request fails (#69, ARCHITECTURE D14). Load comes from k6 inside the
# cluster, through the API Service, so a pod that is shutting down but still an
# endpoint shows up as a failed request.
#
#   bash scripts/rollout-no-drop.sh                  # restart, on the cluster kubectl points at
#   ACTION=undo bash scripts/rollout-no-drop.sh      # roll back to the previous revision
#
# NAMESPACE (contentcollab), ACTION (restart or undo), RATE (50 req/s),
# DURATION (90s of load), WARMUP (10 s of load before the rollout),
# MAX_NODE_MEMORY_PCT (90: refuses to add a load generator above it),
# TARGET (the API Service's /metrics).
#
# TARGET is /metrics, not /health: /health answers 503 whenever Postgres or
# Redis misses its check, and the Redis ping gives up after 500 ms, so under
# load it can fail with no rollout at all; that would hide the result. /metrics
# has no dependencies, so a failure here is a connection or pod problem.
#
# It fails, rather than passing, when the rollout does not finish while the
# load is still running, so a pass always means a rollout happened under load.
# Limits: that check reads the load Job's status once, right after the
# rollout, and k6 stays up a few seconds after its last request, so keep
# DURATION at least twice the rollout's length (a restart of two pods took
# 33 s locally). It also fails when k6 sent under half the requests the rate
# asks for, or when the Job cannot be read.
set -euo pipefail
cd "$(dirname "$0")/.."   # paths relative to the repository root
# shellcheck source=scripts/lib/k6-job.sh
. scripts/lib/k6-job.sh

: "${NAMESPACE:=contentcollab}"
: "${ACTION:=restart}"
: "${TARGET:=http://api.$NAMESPACE.svc.cluster.local:3000/metrics}"
: "${RATE:=50}"
: "${DURATION:=90s}"
: "${WARMUP:=10}"
: "${MAX_NODE_MEMORY_PCT:=90}"
case "$ACTION" in restart|undo) ;; *) die "ACTION '$ACTION' must be restart or undo" ;; esac
[[ "$NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "NAMESPACE '$NAMESPACE' is not a Kubernetes namespace name"
[[ "$K6_IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die "K6_IMAGE '$K6_IMAGE' is not an image reference"
[[ "$RATE" =~ ^[1-9][0-9]*$ ]] || die "RATE '$RATE' is not a number of requests per second"
[[ "$WARMUP" =~ ^[0-9]+$ ]] || die "WARMUP '$WARMUP' is not a number of seconds"
[[ "$MAX_NODE_MEMORY_PCT" =~ ^[1-9][0-9]?$|^100$ ]] || die "MAX_NODE_MEMORY_PCT '$MAX_NODE_MEMORY_PCT' is not a percentage"
total=$(seconds_of "$DURATION")
command -v kubectl >/dev/null || die "kubectl is required"

echo "Cluster: $(kubectl config current-context); $ACTION under $RATE req/s for $DURATION on $TARGET"
revision() {
  kubectl -n "$NAMESPACE" get deployment api -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}'
}
old=$(revision)
[[ "$old" =~ ^[0-9]+$ ]] || die "cannot read the api Deployment's revision (got '$old'): is NAMESPACE=$NAMESPACE right?"
kubectl -n "$NAMESPACE" get deployment api -o jsonpath='strategy: {.spec.strategy.rollingUpdate}  preStop: {.spec.template.spec.containers[0].lifecycle.preStop}{"\n"}'

# The nodes are small; a load generator on a full node risks evicting API pods
mem=$(node_memory_max || true)
if [ -z "$mem" ]; then
  echo "warning: node memory not readable (kubectl top nodes), so not checked"
elif [ "$mem" -gt "$MAX_NODE_MEMORY_PCT" ]; then
  die "a node is at ${mem}% memory, above MAX_NODE_MEMORY_PCT=$MAX_NODE_MEMORY_PCT: a load generator could get API pods evicted"
else
  echo "Highest node memory: ${mem}% (limit $MAX_NODE_MEMORY_PCT%)"
fi

k6_start "$NAMESPACE" k6-rollout scripts/k6/steady.js "TARGET=$TARGET" "RATE=$RATE" "DURATION=$DURATION"
sleep "$WARMUP"
echo "$(date -u +%T) rollout $ACTION deployment/api (revision $old)"
kubectl -n "$NAMESPACE" rollout "$ACTION" deployment/api
kubectl -n "$NAMESPACE" rollout status deployment/api --timeout=300s
echo "$(date -u +%T) rollout finished"
new=$(revision)
[[ "$new" =~ ^[0-9]+$ ]] || die "cannot read the api Deployment's revision after the rollout (got '$new')"
[ "$new" -gt "$old" ] || die "no new revision after the $ACTION ($old -> $new)"
state=$(k6_state "$NAMESPACE" k6-rollout)
case "$state" in
  Running) ;;
  Done) die "the load ended before the rollout finished: raise DURATION (now $DURATION)" ;;
  *) die "the load Job is $state, not Running, so the load cannot be shown to have run through the rollout: kubectl -n $NAMESPACE get job k6-rollout" ;;
esac

# The logs are printed even when k6 did not finish cleanly: they say why
log=$(k6_wait "$NAMESPACE" k6-rollout $((total + 60))) || { printf '%s\n' "$log"; die "the load Job did not finish cleanly"; }
# k6 wraps console output: time=... level=info msg="FAIL <time> status=..." source=console
printf '%s\n' "$log" | sed -n 's/.*msg="\(FAIL [^"]*\)".*/\1/p' | head -20
line=$(printf '%s\n' "$log" | grep '^RESULT ' | tail -n 1)
[ -n "$line" ] || die "k6 printed no RESULT line: kubectl -n $NAMESPACE logs job/k6-rollout"
requests=$(result_field "$line" requests)
failures=$(result_field "$line" failures)
echo "${line#RESULT }"
echo "Revision $old -> $new: $requests requests, $failures failed"
[[ "$requests" =~ ^[0-9]+$ && "$failures" =~ ^[0-9]+$ ]] \
  || die "the k6 RESULT line has no request count or no failure count, so it proves nothing: $line"
[ "$requests" -gt 0 ] || die "no requests were sent"
expected=$((RATE * total))
[ $((requests * 2)) -ge "$expected" ] \
  || die "k6 sent only $requests of about $expected expected requests: the load generator was starved, so the result proves little"
if [ "$failures" -gt 0 ]; then
  echo "FAIL: $failures of $requests requests failed during the rollout" >&2
  exit 1
fi
echo "PASS: no request failed during the rollout"
