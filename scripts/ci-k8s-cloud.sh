#!/usr/bin/env bash
# Renders and validates the cloud-slice manifests that are not part of the two
# overlays: the DOKS infra overlay (k8s/doks/infra) and the migrate Job
# (k8s/doks/migrate-job.yaml), both from #37. Each is skipped while its file
# does not exist, so CI stays green until that pull request lands.
# The renders are left in $OUT_DIR (default /tmp) for the namespace check in
# ci.yml. Practices INF-5, TST-5. Needs KUBE_VERSION, kubectl and kubeconform.
set -euo pipefail

: "${KUBE_VERSION:?KUBE_VERSION is not set (it is set in the k8s job of .github/workflows/ci.yml)}"
out=${OUT_DIR:-/tmp}
here=$(cd "$(dirname "$0")" && pwd)
infra=k8s/doks/infra
job=k8s/doks/migrate-job.yaml
checked=0
mkdir -p "$out"

if [ -f "$infra/kustomization.yaml" ]; then
  # The overlay lists files in ../../base, outside its own folder, which
  # kustomize's default load restrictor refuses
  kubectl kustomize --load-restrictor=LoadRestrictionsNone "$infra" > "$out/infra.yaml" || {
    echo "::error::$infra does not render"
    exit 1
  }
  bash "$here/ci-kubeconform.sh" "$out/infra.yaml"
  checked=1
fi

if [ -f "$job" ]; then
  # deploy.yml fills __IMAGE_TAG__ with the commit SHA; any other placeholder
  # would reach the cluster as text, so it fails here
  sed 's/__IMAGE_TAG__/ci/g' "$job" > "$out/migrate-job.yaml"
  left=$(grep -oE '__[A-Z][A-Z_]*__' "$out/migrate-job.yaml" | sort -u | tr '\n' ' ' || true)
  [ -z "$left" ] || { echo "::error::$job has placeholders the deploy does not fill: $left"; exit 1; }
  bash "$here/ci-kubeconform.sh" "$out/migrate-job.yaml"
  checked=1
fi

[ "$checked" = 1 ] || echo "$infra and $job are not in the repository yet: cloud manifest check skipped"
