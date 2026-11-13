# shellcheck shell=bash
# Stand-in kubectl for scripts/restart-test.test.mjs. Logs its arguments to $STUB_DIR/kubectl.argv and the
# events that replace the postgres pod to $STUB_DIR/events, so a pod's UID changes only when it was replaced.
# The marker an INSERT writes is kept in $STUB_DIR/marker; a read finds it only if it asks for that marker.
#   STUB_FORGET=<delete|restart|scale|drain>    reads after that event find no marker (the data was lost)
#   STUB_SAME_UID=1                             the pod is never replaced (its UID never changes)
#   STUB_NODES=<n>                              number of Ready, schedulable nodes (default 2)
#   STUB_NODES_NOT_READY=<n>                    extra nodes that are NotReady (default 0)
#   STUB_NO_TABLE=1                             every read answers that restart_test does not exist
#   STUB_API_RESTARTS_AFTER=<delete|scale>      an API container restarts after that event
#   STUB_API_UNHEALTHY=1                        the API's /health never answers ok
echo "$*" >> "$STUB_DIR/kubectl.argv"
events="$STUB_DIR/events"
touch "$events"
log_event() { echo "$1" >> "$events"; }
forgot() { [ -n "${STUB_FORGET:-}" ] && grep -qx "$STUB_FORGET" "$events"; }
happened() { grep -qx "$1" "$events"; }
case "$*" in
  *"delete pod postgres-0"*) log_event delete ;;
  *"rollout restart deployment/api"*) log_event restart ;;
  *"scale statefulset postgres --replicas=1"*) log_event scale ;;
  *"scale statefulset postgres --replicas=0"*) : ;;
  *" drain "*) log_event drain ;;
  *"get nodes"*)
    for i in $(seq 1 "${STUB_NODES:-2}"); do echo "node-$i ||True"; done
    for i in $(seq 1 "${STUB_NODES_NOT_READY:-0}"); do echo "bad-$i ||False"; done ;;
  *"get pods -l app=api"*)
    # restartCount of each API container; the restart event replaces the pods (counts start again)
    n=0
    if [ -n "${STUB_API_RESTARTS_AFTER:-}" ] && happened "$STUB_API_RESTARTS_AFTER"; then n=1; fi
    echo "$n 0" ;;
  *"get pod postgres-0"*"nodeName"*) echo node-1 ;;
  *"get pod postgres-0"*"metadata.uid"*)
    if [ "${STUB_SAME_UID:-0}" = 1 ]; then echo uid-0; else echo "uid-$(grep -cE 'delete|scale|drain' "$events")"; fi ;;
  *"get pvc data-postgres-0"*) echo "pvc-abc do-block-storage" ;;
  *"exec deploy/api"*"/health"*)
    if [ "${STUB_API_UNHEALTHY:-0}" = 1 ]; then echo 503; else echo 200; fi ;;
  *"exec postgres-0"*|*"exec deploy/api"*)
    case "$*" in
      *"CREATE TABLE"*) : ;;
      *"INSERT"*) echo "$*" | grep -oE "restart-test-[0-9]+-[0-9]+" | head -1 > "$STUB_DIR/marker" ;;
      *)
        if [ "${STUB_NO_TABLE:-0}" = 1 ]; then echo 'ERROR:  relation "restart_test" does not exist'; exit 1; fi
        written=$(cat "$STUB_DIR/marker" 2>/dev/null)
        if forgot || [ -z "$written" ] || [[ "$*" != *"$written"* ]]; then echo 0; else echo 1; fi ;;
    esac ;;
  *) : ;;
esac
exit 0
