# Stand-in kubectl for scripts/kube-context.test.mjs (#106): reports STUB_CONTEXT as the current context and logs every call.
#   STUB_CONTEXT=name   the current context (default stub-context)
#   STUB_NO_CONTEXT=1   `config current-context` fails, as with no context set
echo "$*" >> "$STUB_DIR/kubectl.argv"
case "$*" in
  *"config current-context"*)
    if [ "${STUB_NO_CONTEXT:-0}" = 1 ]; then echo "error: current-context is not set" >&2; exit 1; fi
    echo "${STUB_CONTEXT:-stub-context}" ;;
  *"get hpa"*)
    echo '{"status":{"conditions":[{"type":"AbleToScale","status":"True"},{"type":"ScalingActive","status":"True"}],"currentMetrics":[{"type":"Resource","resource":{"name":"cpu","current":{"averageUtilization":10}}}]}}' ;;
  *"apply "*) cat > /dev/null ;;
  *) exit 0 ;;
esac
