#!/usr/bin/env bash
# Validates rendered manifests against the Kubernetes schemas of each version
# KUBE_VERSION lists, space-separated (INF-5, TST-5). ci.yml sets it once for
# the whole k8s job, so the versions are not repeated at every call and cannot
# drift apart between them. Custom resources (Gateway, ClusterIssuer) are
# checked against the community CRD catalogue.
# Usage: KUBE_VERSION="1.36.0 1.37.0" scripts/ci-kubeconform.sh file.yaml...
set -euo pipefail

: "${KUBE_VERSION:?KUBE_VERSION is not set (it is set in the k8s job of .github/workflows/ci.yml)}"
[ "$#" -gt 0 ] || { echo "ci-kubeconform: no manifest given" >&2; exit 2; }

CRDS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

# Every entry is checked before any validation, so a typo fails the step
for v in $KUBE_VERSION; do
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "ci-kubeconform: '$v' in KUBE_VERSION is not x.y.z" >&2; exit 2; }
done
for v in $KUBE_VERSION; do
  kubeconform -strict -summary -kubernetes-version "$v" \
    -schema-location default -schema-location "$CRDS" "$@" || {
    echo "::error::kubeconform rejected a manifest at Kubernetes $v: $*"
    exit 1
  }
done
