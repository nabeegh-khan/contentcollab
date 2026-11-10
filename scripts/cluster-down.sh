#!/usr/bin/env bash
# Deletes the cluster and the load balancer it created, so nothing bills after
# grading (INF-7). The database volume is deleted with the cluster: take a
# final pg_dump first.
set -euo pipefail
: "${CLUSTER_NAME:=contentcollab}"
read -r -p "Delete cluster $CLUSTER_NAME and its load balancer and volumes? Type the cluster name to confirm: " answer
[ "$answer" = "$CLUSTER_NAME" ] || { echo "not confirmed"; exit 1; }
doctl kubernetes cluster delete "$CLUSTER_NAME" --dangerous --force
