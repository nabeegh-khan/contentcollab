#!/usr/bin/env bash
# Validates rendered manifests against the Kubernetes schemas of one version
# (INF-5, TST-5). ci.yml sets KUBE_VERSION once for the whole k8s job, so the
# version is not repeated at every call and cannot drift apart between them.
# Custom resources (Gateway, ClusterIssuer) are checked against the community
# CRD catalogue. Usage: KUBE_VERSION=1.36.0 scripts/ci-kubeconform.sh file.yaml...
set -euo pipefail

: "${KUBE_VERSION:?KUBE_VERSION is not set (it is set in the k8s job of .github/workflows/ci.yml)}"
[ "$#" -gt 0 ] || { echo "ci-kubeconform: no manifest given" >&2; exit 2; }

CRDS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

kubeconform -strict -summary -kubernetes-version "$KUBE_VERSION" \
  -schema-location default -schema-location "$CRDS" "$@" || {
  echo "::error::kubeconform rejected a manifest at Kubernetes $KUBE_VERSION: $*"
  exit 1
}
