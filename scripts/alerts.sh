#!/usr/bin/env bash
# DigitalOcean alert policies for the cluster nodes (OBS-3, #55): CPU, memory
# and disk at 80 percent for five minutes, emailed to ALERT_EMAIL. Repeatable:
# a policy that already exists with the same description is left alone.
set -euo pipefail
: "${ALERT_EMAIL:?set ALERT_EMAIL to the address that receives alerts}"
: "${CLUSTER_NAME:=contentcollab}"
command -v doctl >/dev/null || { echo "missing: doctl"; exit 1; }

# The droplets behind the node pool carry the cluster's tag
tag="k8s:$(doctl kubernetes cluster get "$CLUSTER_NAME" --format ID --no-header)"

ensure() { # type, description
  if doctl monitoring alert list --format Description --no-header | grep -qx "$2"; then
    echo "exists: $2"
  else
    doctl monitoring alert create --type "$1" --compare GreaterThan --value 80 --window 5m \
      --tags "$tag" --emails "$ALERT_EMAIL" --description "$2" >/dev/null
    echo "created: $2"
  fi
}
ensure v1/insights/droplet/cpu                         "contentcollab node CPU above 80% for 5 minutes"
ensure v1/insights/droplet/memory_utilization_percent  "contentcollab node memory above 80% for 5 minutes"
ensure v1/insights/droplet/disk_utilization_percent    "contentcollab node disk above 80% for 5 minutes"
