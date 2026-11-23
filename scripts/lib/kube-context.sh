# Sourced by the scripts that change a cluster (#106, D32, INF-20): stops unless kubectl's current context is the one named.
#   require_kube_context "${KUBE_CONTEXT:-}"     # an empty name stops too: the current context is never assumed
require_kube_context() {
  local expected="${1:-}" current
  current=$(kubectl config current-context 2>/dev/null) || current=""
  if [ -z "$expected" ]; then
    echo "set KUBE_CONTEXT to the cluster this script may change (kubectl config get-contexts); kubectl's current context is ${current:-not set}" >&2
    exit 1
  fi
  if [ "$current" != "$expected" ]; then
    echo "kubectl's current context is ${current:+\"$current\"}${current:-not set}, not \"$expected\" (KUBE_CONTEXT): run kubectl config use-context $expected" >&2
    exit 1
  fi
  echo "kubectl context: $current"
}
