# shellcheck shell=bash
# Stand-in kubectl for scripts/pv-retain.test.mjs. Logs its arguments to $STUB_DIR/kubectl.argv; the PV's
# reclaim policy lives in $STUB_DIR/policy, so a patch is seen by the next read.
#   STUB_NO_CLAIM=1      the claim does not exist
#   STUB_POLICY=<p>      the starting reclaim policy (default Delete)
#   STUB_PATCH_NOOP=1    the patch call succeeds but changes nothing
#   STUB_UNBOUND=1       the claim exists but is not bound to a volume yet
echo "$*" >> "$STUB_DIR/kubectl.argv"
policy_file="$STUB_DIR/policy"
[ -f "$policy_file" ] || echo "${STUB_POLICY:-Delete}" > "$policy_file"
case "$*" in
  *"get pvc data-postgres-0"*)
    if [ "${STUB_NO_CLAIM:-0}" = 1 ]; then echo 'Error from server (NotFound): persistentvolumeclaims "data-postgres-0" not found' >&2; exit 1; fi
    [ "${STUB_UNBOUND:-0}" = 1 ] || echo "pvc-123" ;;
  *"get pv pvc-123"*) cat "$policy_file" ;;
  *"patch pv pvc-123"*) [ "${STUB_PATCH_NOOP:-0}" = 1 ] || echo Retain > "$policy_file"; echo "persistentvolume/pvc-123 patched" ;;
  *) : ;;
esac
exit 0
