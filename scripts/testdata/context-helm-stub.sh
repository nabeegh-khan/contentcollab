# Stand-in helm for scripts/kube-context.test.mjs (#106): logs its arguments and reports a Helm 3 version.
echo "$*" >> "$STUB_DIR/helm.argv"
case "$*" in
  "version"*) echo "v3.19.0+g0000000" ;;
  *) exit 0 ;;
esac
