#!/usr/bin/env bash
# Stand-in for kubectl (and sleep) in scripts/rollout-no-drop.test.mjs: logs
# its arguments to $STUB_DIR/calls.log and answers from STUB_* variables.
# Never calls the real tool.
tool=$(basename "$0")
printf '%s %s\n' "$tool" "$*" >> "$STUB_DIR/calls.log"
[ "$tool" = kubectl ] || exit 0
args=" $* "
# Counts calls matching a pattern, so the second revision read differs
bump() { local f="$STUB_DIR/$1.n" n; n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f"; echo "$n"; }
case "$args" in
  *" config current-context "*)
    [ "${STUB_NO_CONTEXT:-0}" = 0 ] || { echo "error: current-context is not set" >&2; exit 1; }
    [ "${STUB_EMPTY_CONTEXT:-0}" = 0 ] || exit 0
    echo stub-cluster ;;
  *"limits.memory"*) printf '%s' "${STUB_API_LIMIT-256Mi}" ;;   # the api container's memory limit
  *"maxSurge"*) printf '%s' "${STUB_SURGE-1}" ;;
  *" get nodes "*)   # name, instance type, allocatable memory; STUB_NODES=1 for one node
    [ "${STUB_NO_NODES:-0}" = 0 ] || { echo 'Error from server (Forbidden): nodes is forbidden' >&2; exit 1; }
    printf 'node-a %s %s\n' "${STUB_TYPE:-s-2vcpu-4gb}" "${STUB_ALLOC:-3074892Ki}"
    [ "${STUB_NODES:-2}" = 1 ] || printf 'node-b %s %s\n' "${STUB_TYPE:-s-2vcpu-4gb}" "${STUB_ALLOC_B:-3074892Ki}" ;;
  *" cluster-autoscaler-status "*)
    [ "${STUB_NO_CAS:-0}" = 0 ] || { echo 'Error from server (NotFound): configmaps "cluster-autoscaler-status" not found' >&2; exit 1; }
    printf 'nodeGroups:\n- health:\n    cloudProviderTarget: 1\n    maxSize: %s\n    minSize: %s\n  name: pool-1\n' "${STUB_CAS_MAX:-2}" "${STUB_CAS_MIN:-1}" ;;
  *'kubernetes\.io/revision'*)   # the script escapes the dots for jsonpath
    if [ "$(bump rev)" = 1 ]; then printf '%s' "${STUB_REV_OLD:-3}"; else printf '%s' "${STUB_REV_NEW:-4}"; fi ;;
  *" get deployment api "*) echo 'strategy: {"maxSurge":1,"maxUnavailable":0}  preStop: {"sleep":{"seconds":10}}' ;;
  *" create configmap "*) printf 'apiVersion: v1\nkind: ConfigMap\n' ;;
  *" apply "*) cat >> "$STUB_DIR/applied.yaml" ;;
  *" top nodes"*)   # usage in bytes (STUB_USED, STUB_USED_B) and percent (STUB_NODE_MEM, STUB_NODE_MEM_B)
    printf 'node-a 200m 10%% %s %s%%\n' "${STUB_USED:-1200Mi}" "${STUB_NODE_MEM:-40}"
    # STUB_TOP_MISSING_B=1: node-b is listed by get nodes but has no metrics yet (a node just added)
    [ "${STUB_NODES:-2}" = 1 ] || [ "${STUB_TOP_MISSING_B:-0}" = 1 ] \
      || printf 'node-b 200m 10%% %s %s%%\n' "${STUB_USED_B:-1100Mi}" "${STUB_NODE_MEM_B:-37}" ;;
  *" get pods "*) printf Running ;;
  *".status.succeeded"*)
    [ "${STUB_JOB_ERR:-0}" = 0 ] || { echo "Error from server (Timeout): the request timed out" >&2; exit 1; }
    # First read comes right after the rollout: still running unless told otherwise
    if [ "$(bump finished)" = 1 ] && [ "${STUB_LOAD_ENDED_EARLY:-0}" = 0 ]; then printf ''; else printf 1; fi ;;
  *".status.failed"*) if [ "${STUB_JOB_FAILED:-0}" = 1 ]; then printf 1; else printf ''; fi ;;
  *" logs "*)
    for _ in $(seq 1 "${STUB_FAILURES:-0}"); do
      echo 'time="2026-11-11T16:21:59Z" level=info msg="FAIL 2026-11-11T16:21:59.662Z status=503 error=-" source=console'
    done
    if [ "${STUB_RESULT_MALFORMED:-0}" = 1 ]; then
      echo 'RESULT {"requests":4500,"dropped_iterations":0,"p95_ms":12}'   # no failures field
    else
      echo "RESULT {\"requests\":${STUB_REQUESTS:-4500},\"failures\":${STUB_FAILURES:-0},\"dropped_iterations\":0,\"p95_ms\":12}"
    fi ;;
esac
exit 0
