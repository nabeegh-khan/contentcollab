#!/usr/bin/env bash
# Installs the observability stack of ARCHITECTURE D19 (part a: Prometheus,
# kube-state-metrics, Grafana) into the namespace `observability` (#109).
#
#   bash scripts/observability-up.sh          # Git Bash, at the repo root
#   DRY_RUN=1 bash scripts/observability-up.sh  # checks only; prints what it would do
#
# Before it changes anything it checks that kubectl points at the expected
# cluster (EXPECTED_CONTEXT, default do-nyc3-contentcollab) and that two nodes
# are Ready: the stack fits one node by requests but not by memory in use
# (D19), so it runs on two. ALLOW_ONE_NODE=1 skips the node check, for a
# short run whose memory is watched. Changing the node pool is left to the
# cluster owner; the script prints the command.
#
# The Grafana admin password is a random value stored in the Secret
# grafana-admin the first time and never printed; the last lines say how to
# read it and how to open Grafana and Prometheus.
set -euo pipefail

: "${EXPECTED_CONTEXT:=do-nyc3-contentcollab}"
: "${CLUSTER:=contentcollab}"
: "${NODE_POOL:=default}"
: "${DRY_RUN:=0}"
: "${ALLOW_ONE_NODE:=0}"
NS=observability
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 1; }

context="$(kubectl config current-context 2>/dev/null || true)"
if [ "$context" != "$EXPECTED_CONTEXT" ]; then
  echo "kubectl context is '${context:-none}', expected '$EXPECTED_CONTEXT'; nothing changed" >&2
  echo "(set EXPECTED_CONTEXT to install somewhere else on purpose)" >&2
  exit 1
fi

# Count Ready nodes; a NotReady node cannot take pods
nodes="$(kubectl get nodes --no-headers)"
ready="$(printf '%s\n' "$nodes" | awk '$2 == "Ready" { n++ } END { print n + 0 }')"
if [ "$ready" -lt 2 ]; then
  if [ "$ALLOW_ONE_NODE" = 1 ]; then
    echo "warning: only $ready Ready node; installing on one node because ALLOW_ONE_NODE=1. Watch kubectl top nodes." >&2
  else
    echo "Only $ready Ready node. The stack runs on two nodes (ARCHITECTURE D19). Raise the pool first:" >&2
    echo "  doctl kubernetes cluster node-pool update $CLUSTER $NODE_POOL --auto-scale --min-nodes 2 --max-nodes 2 --count 2" >&2
    echo "then run this script again once 'kubectl get nodes' shows two Ready nodes. Nothing changed." >&2
    exit 1
  fi
fi

run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "would run: $*"
  else
    "$@"
  fi
}

# Namespace first, so the Secret can be created before the Deployment needs it
if [ "$DRY_RUN" = 1 ]; then
  echo "would create namespace $NS if missing"
else
  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
fi

if kubectl -n "$NS" get secret grafana-admin >/dev/null 2>&1; then
  echo "Secret grafana-admin exists; keeping its password"
elif [ "$DRY_RUN" = 1 ]; then
  echo "would create Secret grafana-admin with a random password"
else
  # 24 random bytes as 48 hex characters; never echoed. A finite read, so
  # no SIGPIPE under pipefail (tr on /dev/urandom piped to head exits 141)
  password="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
  # Piped as a manifest, so the value is never in a command line (which
  # every process on the machine can read); works with Windows kubectl too.
  # create, not apply: apply would copy the password into the
  # last-applied-configuration annotation, which kubectl describe prints
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: grafana-admin\n  namespace: %s\ntype: Opaque\nstringData:\n  admin-password: "%s"\n' \
    "$NS" "$password" | kubectl create -f - >/dev/null
  unset password
  echo "Secret grafana-admin created"
fi

run kubectl apply -k "$ROOT/k8s/observability"

for d in prometheus kube-state-metrics grafana; do
  # Grafana's first start takes about a minute; its startup probe allows five
  run kubectl -n "$NS" rollout status "deploy/$d" --timeout=330s
done

cat <<EOF

Installed in namespace $NS. To look at it (each in its own terminal):
  kubectl -n $NS port-forward svc/grafana 3001:3000      # http://localhost:3001, user admin
  kubectl -n $NS port-forward svc/prometheus 9090:9090   # http://localhost:9090/targets
Grafana password:
  kubectl -n $NS get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
Memory now: kubectl top nodes; kubectl -n $NS top pods
EOF
