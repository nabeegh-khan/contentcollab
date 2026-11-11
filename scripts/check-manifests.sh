#!/usr/bin/env bash
# Checks a rendered overlay against the lecture 8 rows of docs/PRACTICES.md
# (INF-8, INF-9, INF-10, INF-11, SEC-6, OBS-5). Usage:
#   kubectl kustomize k8s/doks | scripts/check-manifests.sh
# Reads the rendered YAML on stdin, needs yq 4, prints one FAIL line per
# problem and exits 1 if there is any. Only Deployments and StatefulSets are
# checked, including their initContainers: Jobs and the Gateway objects are
# not long-running pods. Input with no Deployment or StatefulSet fails, so an
# empty render cannot pass.
set -euo pipefail
command -v yq >/dev/null || { echo "missing: yq 4"; exit 1; }

# Space-separated workload names that may keep root, with the reason in
# docs/CLUSTER_AUDIT.md (SEC-6); matched whole, not as a substring
export ROOT_EXEMPT="${ROOT_EXEMPT:-postgres}"

rendered=$(cat)
workload='select(.kind == "Deployment" or .kind == "StatefulSet")'
containers='(.spec.template.spec.containers, .spec.template.spec.initContainers)[]'
fails=0

# yq prints a "---" between documents; a yq error stops the script (no || true)
lines() { # expression
  local out
  out=$(yq "$1" <<<"$rendered")
  grep -v '^---$' <<<"$out" || true
}

# Runs one yq expression over the rendered YAML; every line it prints is a failure
check() { # row, expression
  local row=$1 line
  while IFS= read -r line; do
    [ -z "$line" ] || { echo "FAIL $row $line"; fails=1; }
  done < <(lines "$2")
}

[ -n "$(lines "$workload | .metadata.name")" ] || { echo "FAIL input: no Deployment or StatefulSet in the rendered YAML"; exit 1; }

# INF-8: the selector's labels are all on the pod template, and every Service
# with a selector picks the app label of a workload that exists
check INF-8 "$workload | .metadata.name as \$n | .spec.template.metadata.labels as \$l
  | .spec.selector.matchLabels | to_entries | .[] | select(\$l[.key] != .value)
  | \$n + \": selector \" + .key + \"=\" + .value + \" is not a pod template label\""
check INF-8 "$workload | select(.spec.selector.matchLabels == null) | .metadata.name + \": no matchLabels in the selector\""
apps=$(lines "$workload | .spec.template.metadata.labels.app")
while IFS== read -r name app; do
  [ -z "$name" ] || grep -qx "$app" <<<"$apps" || { echo "FAIL INF-8 service/$name: no workload labelled app=$app"; fails=1; }
done < <(lines 'select(.kind == "Service") | select(.spec.selector != null) | .metadata.name + "=" + .spec.selector.app')

# INF-9: an explicit tag on every image; :latest only on our own images, which
# CI and cluster-up.sh replace with the commit SHA before anything is applied
check INF-9 "$workload | .metadata.name as \$n | $containers | .image
  | select((test(\":[^/]+\$\") | not) or (test(\":latest\$\") and (test(\"^ghcr.io/nabeegh-khan/contentcollab-\") | not)))
  | \$n + \": image \" + . + \" has no tag or is :latest\""

# INF-10: every container port has a name; Service targetPorts and probe ports
# are names (not numbers, not digit strings) that the selected container declares
check INF-10 "$workload | .metadata.name as \$n | $containers
  | .ports[]? | select(has(\"name\") | not) | \$n + \": containerPort \" + (.containerPort | tostring) + \" has no name\""
check INF-10 "$workload | .metadata.name as \$n | $containers
  | ((.ports // []) | map(.name)) as \$names
  | (.readinessProbe, .livenessProbe, .startupProbe) | select(. != null) | (.httpGet // .tcpSocket) | select(. != null)
  | .port as \$p | select((\$p | tag != \"!!str\") or (\$p | test(\"^[0-9]+\$\")) or ((\$names | any_c(. == \$p)) | not))
  | \$n + \": probe port \" + (.port | tostring) + \" is not a port name the container declares\""
declared=$(lines "$workload | .spec.template.metadata.labels.app as \$a | $containers | .ports[]? | \$a + \"=\" + .name")
while IFS== read -r name app target; do
  [ -z "$name" ] || grep -qx "$app=$target" <<<"$declared" \
    || { echo "FAIL INF-10 service/$name: targetPort $target is not a port name declared by app=$app"; fails=1; }
done < <(lines 'select(.kind == "Service") | select(.spec.selector != null) | .metadata.name as $n | .spec.selector.app as $a | .spec.ports[] | $n + "=" + $a + "=" + ((.targetPort // .port) | tostring)')

# INF-11: liveness never asks about dependencies, so it must not call /health
check INF-11 "$workload | .metadata.name as \$n | $containers
  | select((.livenessProbe.httpGet.path // \"\") == \"/health\") | \$n + \": livenessProbe calls \" + .livenessProbe.httpGet.path"

# OBS-5: requests and limits for cpu and memory on every container
check OBS-5 "$workload | .metadata.name as \$n | $containers
  | select([.resources.requests.cpu // \"\", .resources.requests.memory // \"\", .resources.limits.cpu // \"\", .resources.limits.memory // \"\"] | map(. == \"\") | any)
  | \$n + \"/\" + .name + \": missing a cpu or memory request or limit\""

# SEC-6: runAsNonRoot true on the pod or the container, and never false on the
# container; workloads named in ROOT_EXEMPT are skipped
# (a variable bound after a failed select would still be emitted by yq, so the
# bindings come first and every message uses the container's own fields)
check SEC-6 "$workload | .metadata.name as \$n | .spec.template.spec as \$p
  | select(((strenv(ROOT_EXEMPT) | split(\" \")) | any_c(. == \$n)) | not)
  | $containers
  | select((.securityContext.runAsNonRoot | tostring) == \"false\" or (((.securityContext.runAsNonRoot // false) or (\$p.securityContext.runAsNonRoot // false)) | not))
  | \$n + \"/\" + .name + \": runAsNonRoot is not true\""

if [ "$fails" = 0 ]; then echo "ok: lecture 8 rows hold in the rendered overlay"; fi
exit "$fails"
