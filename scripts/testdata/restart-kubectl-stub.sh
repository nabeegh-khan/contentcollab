# shellcheck shell=bash
# Stand-in kubectl for scripts/restart-test.test.mjs. Logs its arguments to $STUB_DIR/kubectl.argv and the
# events that replace the postgres pod to $STUB_DIR/events, so a pod's UID changes only when it was replaced.
#   STUB_FORGET=<delete|restart|scale|drain>  reads after that event find no marker (the data was lost)
#   STUB_SAME_UID=1                           the pod is never replaced (its UID never changes)
#   STUB_NODES=<n>                            number of nodes (default 2)
echo "$*" >> "$STUB_DIR/kubectl.argv"
events="$STUB_DIR/events"
touch "$events"
log_event() { echo "$1" >> "$events"; }
forgot() { [ -n "${STUB_FORGET:-}" ] && grep -qx "$STUB_FORGET" "$events"; }
case "$*" in
  *"delete pod postgres-0"*) log_event delete ;;
  *"rollout restart deployment/api"*) log_event restart ;;
  *"scale statefulset postgres --replicas=1"*) log_event scale ;;
  *"scale statefulset postgres --replicas=0"*) : ;;
  *" drain "*) log_event drain ;;
  *"get nodes"*) n=${STUB_NODES:-2}; for i in $(seq 1 "$n"); do echo "node-$i"; done ;;
  *"get pod postgres-0"*"nodeName"*) echo node-1 ;;
  *"get pod postgres-0"*"metadata.uid"*)
    if [ "${STUB_SAME_UID:-0}" = 1 ]; then echo uid-0; else echo "uid-$(grep -cE 'delete|scale|drain' "$events")"; fi ;;
  *"get pvc data-postgres-0"*) echo "pvc-abc do-block-storage" ;;
  *"exec postgres-0"*|*"exec deploy/api"*)
    case "$*" in
      *"CREATE TABLE"*|*"INSERT"*) : ;;
      *) if forgot; then echo 0; else echo 1; fi ;;
    esac ;;
  *) : ;;
esac
exit 0
