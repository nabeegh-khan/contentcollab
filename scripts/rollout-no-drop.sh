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
# MIN_NODE_FREE_MIB (default: the k6 pod's memory limit, 512, plus maxSurge
# times the api container's memory limit, both read from the Deployment: what
# the run can add to one node), ALLOW_UNCHECKED_MEMORY (1 to run when no
# node's memory can be read), TARGET (the API Service's /metrics).
#
# Every node whose memory can be read must have MIN_NODE_FREE_MIB free, or the
# run stops before it changes anything. A node with no reading (for example
# one the autoscaler has just added, before metrics-server reports it) is
# named as not checked; if no node can be read the run stops unless
# ALLOW_UNCHECKED_MEMORY=1. When MIN_NODE_FREE_MIB is set the Deployment is
# not read for it.
#
# Nothing about the cluster is assumed: it prints the kubectl context, the
# nodes with their size and allocatable memory, and the node autoscaler's
# bounds as the cluster reports them, and measures free memory in MiB
# (allocatable minus use), so the same check holds for one 4 GB node or two
# 2 GB ones. If the autoscaler adds a node during the run, the printout from
# before the run does not show it: watch kubectl get nodes alongside.
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
: "${MIN_NODE_FREE_MIB:=}"   # empty: worked out from the Deployment below
: "${ALLOW_UNCHECKED_MEMORY:=0}"
case "$ACTION" in restart|undo) ;; *) die "ACTION '$ACTION' must be restart or undo" ;; esac
[[ "$NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "NAMESPACE '$NAMESPACE' is not a Kubernetes namespace name"
[[ "$K6_IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die "K6_IMAGE '$K6_IMAGE' is not an image reference"
[[ "$RATE" =~ ^[1-9][0-9]*$ ]] || die "RATE '$RATE' is not a number of requests per second"
[[ "$WARMUP" =~ ^[0-9]+$ ]] || die "WARMUP '$WARMUP' is not a number of seconds"
[[ -z "$MIN_NODE_FREE_MIB" || "$MIN_NODE_FREE_MIB" =~ ^[0-9]+$ ]] || die "MIN_NODE_FREE_MIB '$MIN_NODE_FREE_MIB' is not a number of MiB"
total=$(seconds_of "$DURATION")
command -v kubectl >/dev/null || die "kubectl is required"

ctx=$(kubectl config current-context) && [ -n "$ctx" ]   || die "kubectl has no current context: point it at the cluster first (doctl kubernetes cluster kubeconfig save <name>)"
echo "Cluster: $ctx; $ACTION under $RATE req/s for $DURATION on $TARGET"
echo "Nodes: $(node_shape)"
bounds=$(autoscaler_bounds || true)
echo "Node autoscaling: ${bounds:-not readable (kube-system/cluster-autoscaler-status)}"
revision() {
  kubectl -n "$NAMESPACE" get deployment api -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}'
}
old=$(revision)
[[ "$old" =~ ^[0-9]+$ ]] || die "cannot read the api Deployment's revision (got '$old'): is NAMESPACE=$NAMESPACE right?"
kubectl -n "$NAMESPACE" get deployment api -o jsonpath='strategy: {.spec.strategy.rollingUpdate}  preStop: {.spec.template.spec.containers[0].lifecycle.preStop}{"\n"}'

# A load generator on a node without room for it risks evicting API pods. In
# MiB, not percent: 10% of a 4 GB node is under k6's own limit. The rollout
# also adds maxSurge new api pods beside the old ones, on any node
if [ -n "$MIN_NODE_FREE_MIB" ]; then
  why="set by MIN_NODE_FREE_MIB"
else
  api_limit=$(kubectl -n "$NAMESPACE" get deployment api -o 'jsonpath={.spec.template.spec.containers[0].resources.limits.memory}' || true)
  surge=$(kubectl -n "$NAMESPACE" get deployment api -o 'jsonpath={.spec.strategy.rollingUpdate.maxSurge}' || true)
  api_mib=$(quantity_mib "$api_limit")
  [[ -n "$api_mib" && "$surge" =~ ^[0-9]+$ ]] \
    || die "cannot size the surge: api memory limit '$api_limit', maxSurge '$surge' (a whole number of pods is needed); set MIN_NODE_FREE_MIB to the MiB the run may add to a node"
  MIN_NODE_FREE_MIB=$((K6_MEMORY_LIMIT_MI + surge * api_mib))
  why="k6 $K6_MEMORY_LIMIT_MI MiB + $surge surge api pod(s) of $api_mib MiB"
fi
report=$(node_free_report || true)
checked=0 least_name="" least_free=""
while read -r state name free; do
  [ -n "$state" ] || continue
  if [ "$state" != ok ]; then
    echo "warning: $name: memory not readable, not checked"
    continue
  fi
  checked=$((checked + 1))
  [ "$free" -ge "$MIN_NODE_FREE_MIB" ] \
    || die "$name has $free MiB free, under MIN_NODE_FREE_MIB=$MIN_NODE_FREE_MIB ($why): the run could get API pods evicted"
  if [ -z "$least_free" ] || [ "$free" -lt "$least_free" ]; then least_name=$name least_free=$free; fi
done <<< "$report"
if [ "$checked" -gt 0 ]; then
  echo "Least free memory: $least_name $least_free MiB (needs $MIN_NODE_FREE_MIB)"
elif [ "$ALLOW_UNCHECKED_MEMORY" = 1 ]; then
  echo "warning: no node's memory could be read (kubectl get nodes, kubectl top nodes); not checked, as ALLOW_UNCHECKED_MEMORY=1 asks"
else
  die "no node's memory could be read (kubectl get nodes, kubectl top nodes), so the run cannot be shown not to evict API pods; wait for metrics, or set ALLOW_UNCHECKED_MEMORY=1"
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
