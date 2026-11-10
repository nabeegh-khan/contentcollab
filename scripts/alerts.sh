#!/usr/bin/env bash
# DigitalOcean alert policies for the cluster nodes (OBS-3, #55): CPU, memory
# and disk at 80 percent for five minutes, emailed to ALERT_EMAIL. Repeatable:
# a policy with the same description, which names the cluster's tag, is left
# alone. A rebuilt cluster has a new ID, so it gets its own policies; the old
# cluster's policies stay until deleted (doctl monitoring alert delete).
set -euo pipefail
: "${ALERT_EMAIL:?set ALERT_EMAIL to the address that receives alerts}"
: "${CLUSTER_NAME:=contentcollab}"
command -v doctl >/dev/null || { echo "missing: doctl"; exit 1; }

# The droplets behind the node pool carry the cluster's tag
tag="k8s:$(doctl kubernetes cluster get "$CLUSTER_NAME" --format ID --no-header)"
existing=$(doctl monitoring alert list --format Description --no-header)

ensure() { # type, what
  local description="$CLUSTER_NAME node $2 above 80% for 5 minutes ($tag)"
  # Fixed-string, whole-line match on a captured list (no pipe for grep to cut short)
  if grep -qxF "$description" <<<"$existing"; then
    echo "exists: $description"
  else
    doctl monitoring alert create --type "$1" --compare GreaterThan --value 80 --window 5m \
      --tags "$tag" --emails "$ALERT_EMAIL" --description "$description" >/dev/null
    echo "created: $description"
  fi
}
ensure v1/insights/droplet/cpu                         CPU
ensure v1/insights/droplet/memory_utilization_percent  memory
ensure v1/insights/droplet/disk_utilization_percent    disk
