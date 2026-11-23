# Stand-in git for scripts/kube-context.test.mjs (#106): a fetch that does nothing, so no test reaches the network.
echo "$*" >> "$STUB_DIR/git.argv"
exit 0
