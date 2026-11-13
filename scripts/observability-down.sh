#!/usr/bin/env bash
# Removes the observability stack of ARCHITECTURE D19 (#109): everything
# `kubectl apply -k k8s/observability` created, including the namespace (and
# with it the Grafana password Secret and the 24 hours of data) and the
# cluster-wide roles. Prints the command that lets the node pool go back to
# one node; changing the pool is left to the cluster owner.
#
#   bash scripts/observability-down.sh   # Git Bash, at the repo root
set -euo pipefail

: "${EXPECTED_CONTEXT:=do-nyc3-contentcollab}"
: "${CLUSTER:=contentcollab}"
: "${NODE_POOL:=default}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 1; }

context="$(kubectl config current-context 2>/dev/null || true)"
if [ "$context" != "$EXPECTED_CONTEXT" ]; then
  echo "kubectl context is '${context:-none}', expected '$EXPECTED_CONTEXT'; nothing changed" >&2
  exit 1
fi

kubectl delete -k "$ROOT/k8s/observability" --ignore-not-found --wait=true

cat <<EOF

Removed. The pool stays at two nodes until its minimum is lowered:
  doctl kubernetes cluster node-pool update $CLUSTER $NODE_POOL --auto-scale --min-nodes 1 --max-nodes 2
The autoscaler then removes the spare node once its pods fit on the other.
EOF
