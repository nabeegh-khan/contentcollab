# Stand-in doctl for scripts/kube-context.test.mjs (#106): logs its arguments; the cluster is in nyc3; STUB_NO_CLUSTER=1 makes `cluster get` fail, as when the cluster does not exist yet.
echo "$*" >> "$STUB_DIR/doctl.argv"
case "$*" in
  *"cluster get"*"--format Region"*) echo nyc3 ;;
  "kubernetes cluster get "*) [ "${STUB_NO_CLUSTER:-0}" = 1 ] && exit 1; exit 0 ;;
  *) exit 0 ;;
esac
