# Stand-in kubectl for tests/test_deploy_undo.py (#108): per-Deployment image and revision kept as files in $STUB_DIR.
# Settings (files in $STUB_DIR): apply-changes (services the apply moves to $STUB_SHA), apply-fails (non-empty: the apply
# exits 1 after its changes), status-fails (services whose rollout status fails), undo-fails (services whose undo fails).
set -u
echo "kubectl $*" >> "$STUB_DIR/calls.log"
args=" $* "
svc=""
for word in "$@"; do
  case "$word" in deployment/*) svc="${word#deployment/}" ;; esac
done
listed() { grep -qx "$1" "$STUB_DIR/$2" 2>/dev/null; }

case "$args" in
  *" apply -k "*)
    for s in api worker; do
      if listed "$s" apply-changes; then
        echo "registry/contentcollab-$s:$STUB_SHA" > "$STUB_DIR/image-$s"
        echo $(( $(cat "$STUB_DIR/rev-$s") + 1 )) > "$STUB_DIR/rev-$s"
      fi
    done
    [ -s "$STUB_DIR/apply-fails" ] && { echo "error: apply failed partway" >&2; exit 1; }
    exit 0 ;;
  *" get deployment/"*"revision"*) cat "$STUB_DIR/rev-$svc" ;;
  *" get deployment/"*"image"*) cat "$STUB_DIR/image-$svc" ;;
  *" rollout status "*) listed "$svc" status-fails && exit 1; exit 0 ;;
  *" rollout undo "*)
    listed "$svc" undo-fails && exit 1
    echo "registry/contentcollab-$svc:previous" > "$STUB_DIR/image-$svc"
    echo $(( $(cat "$STUB_DIR/rev-$svc") + 1 )) > "$STUB_DIR/rev-$svc"
    exit 0 ;;
  *) exit 0 ;;
esac
