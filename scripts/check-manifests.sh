#!/usr/bin/env bash
# Checks a rendered overlay against the lecture 8 rows of docs/PRACTICES.md
# (INF-8, INF-9, INF-10, INF-11, SEC-6, OBS-5). Usage:
#   kubectl kustomize k8s/doks | scripts/check-manifests.sh
# Reads the rendered YAML on stdin, needs yq 4, prints one FAIL line per
# problem and exits 1 if there is any. Only Deployments and StatefulSets are
# checked: Jobs and the Gateway objects are not long-running pods.
set -euo pipefail
command -v yq >/dev/null || { echo "missing: yq 4"; exit 1; }

# One pod that may keep root, with the reason in docs/CLUSTER_AUDIT.md (SEC-6)
: "${ROOT_EXEMPT:=postgres}"

rendered=$(cat)
workload='select(.kind == "Deployment" or .kind == "StatefulSet")'
fails=0

# Runs one yq expression over the rendered YAML; every line it prints is a failure
check() { # row, expression
  local row=$1 out
  out=$(yq "$2" <<<"$rendered" | grep -v '^---$' || true)
  [ -z "$out" ] && return 0
  while IFS= read -r line; do echo "FAIL $row $line"; done <<<"$out"
  fails=1
}

# INF-8: the selector's labels are all on the pod template, and every Service
# selects the app label of a workload that exists
check INF-8 "$workload | .metadata.name as \$n | .spec.template.metadata.labels as \$l
  | .spec.selector.matchLabels | to_entries | .[] | select(\$l[.key] != .value)
  | \$n + \": selector \" + .key + \"=\" + .value + \" is not a pod template label\""
apps=$(yq "$workload | .spec.template.metadata.labels.app" <<<"$rendered" | grep -v '^---$' || true)
for svc in $(yq 'select(.kind == "Service") | .metadata.name + "=" + .spec.selector.app' <<<"$rendered" | grep -v '^---$'); do
  grep -qx "${svc#*=}" <<<"$apps" || { echo "FAIL INF-8 service/${svc%%=*}: no workload labelled app=${svc#*=}"; fails=1; }
done

# INF-9: an explicit tag on every image; :latest only on our own images, which
# CI and cluster-up.sh replace with the commit SHA before anything is applied
check INF-9 "$workload | .metadata.name as \$n | .spec.template.spec.containers[] | .image
  | select((test(\":[^/]+\$\") | not) or (test(\":latest\$\") and (test(\"^ghcr.io/nabeegh-khan/contentcollab-\") | not)))
  | \$n + \": image \" + . + \" has no tag or is :latest\""

# INF-10: every container port has a name; Service targetPorts and probe ports use names
check INF-10 "$workload | .metadata.name as \$n | .spec.template.spec.containers[]
  | .ports[]? | select(has(\"name\") | not) | \$n + \": containerPort \" + (.containerPort | tostring) + \" has no name\""
check INF-10 "select(.kind == \"Service\") | .metadata.name as \$n | .spec.ports[]
  | select((.targetPort // 0) | tag != \"!!str\") | \"service/\" + \$n + \": targetPort \" + ((.targetPort // .port) | tostring) + \" is a number, not a port name\""
check INF-10 "$workload | .metadata.name as \$n | .spec.template.spec.containers[]
  | (.readinessProbe, .livenessProbe) | select(. != null) | (.httpGet // .tcpSocket) | select(. != null)
  | select(.port | tag != \"!!str\") | \$n + \": probe port \" + (.port | tostring) + \" is a number, not a port name\""

# INF-11: liveness never asks about dependencies, so it must not call /health
check INF-11 "$workload | .metadata.name as \$n | .spec.template.spec.containers[]
  | select((.livenessProbe.httpGet.path // \"\") == \"/health\") | \$n + \": livenessProbe calls \" + .livenessProbe.httpGet.path"

# OBS-5: requests and limits for cpu and memory on every container
check OBS-5 "$workload | .metadata.name as \$n | .spec.template.spec.containers[]
  | select([.resources.requests.cpu // \"\", .resources.requests.memory // \"\", .resources.limits.cpu // \"\", .resources.limits.memory // \"\"] | map(. == \"\") | any)
  | \$n + \"/\" + .name + \": missing a cpu or memory request or limit\""

# SEC-6: runAsNonRoot on the pod or each container, except the named pods
check SEC-6 "$workload | .metadata.name as \$n | select(([\"$ROOT_EXEMPT\"] | contains([\$n])) | not)
  | .spec.template.spec as \$p | \$p.containers[]
  | select(((\$p.securityContext.runAsNonRoot // false) != true) and ((.securityContext.runAsNonRoot // false) != true))
  | \$n + \"/\" + .name + \": runAsNonRoot is not true\""

if [ "$fails" = 0 ]; then echo "ok: lecture 8 rows hold in the rendered overlay"; fi
exit "$fails"
