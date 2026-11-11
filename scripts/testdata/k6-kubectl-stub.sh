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
  *" config current-context "*) echo stub-cluster ;;
  *'kubernetes\.io/revision'*)   # the script escapes the dots for jsonpath
    if [ "$(bump rev)" = 1 ]; then printf '%s' "${STUB_REV_OLD:-3}"; else printf '%s' "${STUB_REV_NEW:-4}"; fi ;;
  *" get deployment api "*) echo 'strategy: {"maxSurge":1,"maxUnavailable":0}  preStop: {"sleep":{"seconds":10}}' ;;
  *" create configmap "*) printf 'apiVersion: v1\nkind: ConfigMap\n' ;;
  *" apply "*) cat >> "$STUB_DIR/applied.yaml" ;;
  *" top nodes"*)
    printf 'node-a 200m 10%% 1200Mi %s%%\nnode-b 200m 10%% 1100Mi %s%%\n' "${STUB_NODE_MEM:-60}" "${STUB_NODE_MEM_B:-55}" ;;
  *" get pods "*) printf Running ;;
  *".status.succeeded"*)
    # First read comes right after the rollout: still running unless told otherwise
    if [ "$(bump finished)" = 1 ] && [ "${STUB_LOAD_ENDED_EARLY:-0}" = 0 ]; then printf ''; else printf 1; fi ;;
  *".status.failed"*) printf '' ;;
  *" logs "*)
    for _ in $(seq 1 "${STUB_FAILURES:-0}"); do
      echo 'time="2026-11-11T16:21:59Z" level=info msg="FAIL 2026-11-11T16:21:59.662Z status=503 error=-" source=console'
    done
    echo "RESULT {\"requests\":${STUB_REQUESTS:-4500},\"failures\":${STUB_FAILURES:-0},\"dropped_iterations\":0,\"p95_ms\":12}" ;;
esac
exit 0
