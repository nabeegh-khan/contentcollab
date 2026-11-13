#!/usr/bin/env bash
# Sets the PostgreSQL volume's PersistentVolume to Retain (#104; INF-14, DB-12; lecture 9 p30), so deleting
# the claim data-postgres-0 or the namespace leaves the DigitalOcean volume and the database on it.
# The doks overlay keeps the claim on do-block-storage (Delete): a StatefulSet's volumeClaimTemplates cannot
# be changed in place (kubernetes pkg/apis/apps/validation/validation.go, ValidateImmutableField on
# VolumeClaimTemplates), so changing its class would make every `kubectl apply -k k8s/doks` fail. The PV
# itself can be patched at any time, and back with "Delete".
# Not a backup (a dropped table is still gone), and not proof against `doctl kubernetes cluster delete
# --dangerous`, which deletes the cluster's volumes whatever their policy.
#
#   KUBE_CONTEXT=<cluster> scripts/pv-retain.sh
# Settings: NAMESPACE (contentcollab), CLAIM (data-postgres-0).
set -euo pipefail

: "${KUBE_CONTEXT:?set KUBE_CONTEXT to the cluster (kubectl config get-contexts)}"
: "${NAMESPACE:=contentcollab}"
: "${CLAIM:=data-postgres-0}"
command -v kubectl >/dev/null || { echo "missing: kubectl"; exit 1; }

k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

pv=$(k -n "$NAMESPACE" get pvc "$CLAIM" -o jsonpath='{.spec.volumeName}') || { echo "could not read claim $CLAIM in $NAMESPACE on $KUBE_CONTEXT" >&2; exit 1; }
[ -n "$pv" ] || { echo "claim $CLAIM in $NAMESPACE on $KUBE_CONTEXT is not bound yet" >&2; exit 1; }
policy() { k get pv "$pv" -o jsonpath='{.spec.persistentVolumeReclaimPolicy}'; }

before=$(policy)
if [ "$before" = Retain ]; then echo "$pv is already Retain"; exit 0; fi
k patch pv "$pv" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}' >/dev/null
after=$(policy)
[ "$after" = Retain ] || { echo "FAIL: $pv is still $after" >&2; exit 1; }
echo "$pv: $before -> $after (claim $NAMESPACE/$CLAIM, context $KUBE_CONTEXT)"
