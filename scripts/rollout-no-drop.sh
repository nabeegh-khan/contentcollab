#!/usr/bin/env bash
# Rolling restart of the API under steady load; exits 1 if any request fails
# (#69, ARCHITECTURE D14). Load comes from k6 inside the cluster, through the
# API Service, so a pod that is shutting down but still an endpoint shows up
# as a failed request.
#
#   bash scripts/rollout-no-drop.sh                      # the cluster kubectl points at
#   KUBECONFIG=<k3s kubeconfig> bash scripts/rollout-no-drop.sh
#
# NAMESPACE (contentcollab), TARGET (the API Service's /health), RATE (50
# req/s), DURATION (90s of load), WARMUP (10 s of load before the restart).
# It fails, rather than passing, when the rollout does not finish while the
# load is still running, so a pass always means a rollout happened under load.
set -euo pipefail
cd "$(dirname "$0")/.."   # paths relative to the repository root
# shellcheck source=scripts/lib/k6-job.sh
. scripts/lib/k6-job.sh

: "${NAMESPACE:=contentcollab}"
: "${TARGET:=http://api.$NAMESPACE.svc.cluster.local:3000/health}"
: "${RATE:=50}"
: "${DURATION:=90s}"
: "${WARMUP:=10}"
[[ "$RATE" =~ ^[1-9][0-9]*$ ]] || die "RATE '$RATE' is not a number of requests per second"
[[ "$WARMUP" =~ ^[0-9]+$ ]] || die "WARMUP '$WARMUP' is not a number of seconds"
total=$(seconds_of "$DURATION")
command -v kubectl >/dev/null || die "kubectl is required"

echo "Cluster: $(kubectl config current-context); load: $RATE req/s for $DURATION on $TARGET"
old=$(kubectl -n "$NAMESPACE" get deployment api -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')
kubectl -n "$NAMESPACE" get deployment api -o jsonpath='strategy: {.spec.strategy.rollingUpdate}  preStop: {.spec.template.spec.containers[0].lifecycle.preStop}{"\n"}'

k6_start "$NAMESPACE" k6-rollout scripts/k6/steady.js "TARGET=$TARGET" "RATE=$RATE" "DURATION=$DURATION"
sleep "$WARMUP"
echo "$(date -u +%T) rollout restart deployment/api (revision $old)"
kubectl -n "$NAMESPACE" rollout restart deployment/api
kubectl -n "$NAMESPACE" rollout status deployment/api --timeout=300s
echo "$(date -u +%T) rollout finished"
new=$(kubectl -n "$NAMESPACE" get deployment api -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')
[ "$new" -gt "$old" ] || die "no new revision after the restart ($old -> $new)"
[ "$(k6_state "$NAMESPACE" k6-rollout)" = Running ] \
  || die "the load ended before the rollout finished: raise DURATION (now $DURATION)"

log=$(k6_wait "$NAMESPACE" k6-rollout $((total + 60)))
# k6 wraps console output: time=... level=info msg="FAIL <time> status=..." source=console
printf '%s\n' "$log" | sed -n 's/.*msg="\(FAIL [^"]*\)".*/\1/p' | head -20
line=$(printf '%s\n' "$log" | grep '^RESULT ' | tail -n 1)
[ -n "$line" ] || die "k6 printed no RESULT line: kubectl -n $NAMESPACE logs job/k6-rollout"
requests=$(result_field "$line" requests)
failures=$(result_field "$line" failures)
echo "${line#RESULT }"
echo "Revision $old -> $new: $requests requests, $failures failed"
[ "${requests:-0}" -gt 0 ] || die "no requests were sent"
if [ "$failures" -gt 0 ]; then
  echo "FAIL: $failures of $requests requests failed during the rollout" >&2
  exit 1
fi
echo "PASS: no request failed during the rollout"
