# Stand-in doctl for scripts/kube-context.test.mjs (#106): logs its arguments; the cluster is in nyc3.
echo "$*" >> "$STUB_DIR/doctl.argv"
case "$*" in
  *"cluster get"*"--format Region"*) echo nyc3 ;;
  *) exit 0 ;;
esac
