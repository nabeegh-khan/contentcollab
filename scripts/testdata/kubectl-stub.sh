# Stand-in kubectl for the script tests: logs its arguments, answers the few calls scripts/app-secret.sh
# makes, keeps what is applied. Driven by environment variables:
#   STUB_EXISTS=1          the Secret exists
#   STUB_GET_ERROR=text    reading the Secret fails with this message (default: NotFound when absent)
#   STUB_DATA_<KEY>=b64    the stored value of a key
#   STUB_NO_NAMESPACE=1    the namespace does not exist
echo "$*" >> "$STUB_DIR/kubectl.argv"
case "$*" in
  *"get secret"*"-o name"*)
    if [ -n "${STUB_GET_ERROR:-}" ]; then echo "$STUB_GET_ERROR" >&2; exit 1; fi
    # --ignore-not-found: an absent Secret prints nothing and succeeds
    if [ "${STUB_EXISTS:-0}" = 1 ]; then echo secret/app-secrets; fi
    exit 0 ;;
  *annotate*)
    if [ "${STUB_ANNOTATE_FAIL:-0}" = 1 ]; then echo "error: annotate failed" >&2; exit 1; fi
    exit 0 ;;
  *"get secret"*"jsonpath="*)
    key=$(printf '%s' "$*" | sed -n 's/.*jsonpath={\.data\.\([A-Z_]*\)}.*/\1/p')
    var="STUB_DATA_$key"
    printf '%s' "${!var:-}" ;;
  *"get namespace"*)
    if [ "${STUB_NO_NAMESPACE:-0}" = 1 ]; then echo 'Error from server (NotFound): namespaces "contentcollab" not found' >&2; exit 1; fi
    echo namespace/contentcollab ;;
  *"apply "*)
    cat > "$STUB_DIR/apply.stdin"
    if [ "${STUB_APPLY_FAIL:-0}" = 1 ]; then echo "error: apply failed" >&2; exit 1; fi
    echo "secret/app-secrets serverside-applied" ;;
  *"config current-context"*) echo stub-context ;;
  *) exit 0 ;;
esac
