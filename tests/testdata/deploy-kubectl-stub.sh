# Stand-in kubectl for tests/test_deploy_undo.py (#108): per-Deployment image and revision kept as files in $STUB_DIR.
# Settings (files in $STUB_DIR): apply-changes (services the apply moves to $STUB_SHA), apply-fails (non-empty: the apply
# exits 1 after its changes), status-fails (services whose rollout status fails), undo-fails (services whose undo fails),
# rev-read-fails (services whose revision cannot be read once the file "applied" exists, which the apply creates),
# rev-read-fails-before (the same, before the apply), absent (services with no Deployment yet: NotFound, or empty
# output with --ignore-not-found; the apply creates them at revision 1).
set -u
echo "kubectl $*" >> "$STUB_DIR/calls.log"
args=" $* "
svc=""
for word in "$@"; do
  case "$word" in deployment/*) svc="${word#deployment/}" ;; esac
done
listed() { grep -qx "$1" "$STUB_DIR/$2" 2>/dev/null; }
unlist() { grep -vx "$1" "$STUB_DIR/$2" > "$STUB_DIR/$2.tmp" 2>/dev/null; mv "$STUB_DIR/$2.tmp" "$STUB_DIR/$2"; }

case "$args" in
  *" apply -k "*)
    : > "$STUB_DIR/applied"
    for s in api worker web; do
      if listed "$s" apply-changes; then
        if listed "$s" absent; then unlist "$s" absent; echo 0 > "$STUB_DIR/rev-$s"; fi
        echo "registry/contentcollab-$s:$STUB_SHA" > "$STUB_DIR/image-$s"
        echo $(( $(cat "$STUB_DIR/rev-$s") + 1 )) > "$STUB_DIR/rev-$s"
      fi
    done
    [ -s "$STUB_DIR/apply-fails" ] && { echo "error: apply failed partway" >&2; exit 1; }
    exit 0 ;;
  *" get deployment/"*)
    if listed "$svc" absent; then
      case "$args" in *" --ignore-not-found "*) exit 0 ;; esac
      echo "Error from server (NotFound): deployments.apps \"$svc\" not found" >&2; exit 1
    fi
    case "$args" in
      *revision*)
        if { [ -e "$STUB_DIR/applied" ] && listed "$svc" rev-read-fails; } ||
           { [ ! -e "$STUB_DIR/applied" ] && listed "$svc" rev-read-fails-before; }; then
          echo "error: You must be logged in to the server (Unauthorized)" >&2; exit 1
        fi
        cat "$STUB_DIR/rev-$svc" ;;
      *image*) cat "$STUB_DIR/image-$svc" ;;
    esac ;;
  *" rollout status "*) listed "$svc" status-fails && exit 1; exit 0 ;;
  *" rollout undo "*)
    listed "$svc" undo-fails && exit 1
    echo "registry/contentcollab-$svc:previous" > "$STUB_DIR/image-$svc"
    echo $(( $(cat "$STUB_DIR/rev-$svc") + 1 )) > "$STUB_DIR/rev-$svc"
    exit 0 ;;
  *) exit 0 ;;
esac
