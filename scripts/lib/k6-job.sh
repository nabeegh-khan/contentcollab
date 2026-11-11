# Runs a k6 script as a Kubernetes Job in the cluster kubectl points at (#69).
# Inside the cluster the load goes through the Service and kube-proxy, as real
# traffic does; a port-forward would pin it to one pod. Nothing is installed on
# the machine running the script. Sourced, not run.
# shellcheck shell=bash

: "${K6_IMAGE:=grafana/k6:2.3.0}"   # github.com/grafana/k6/releases, checked 11 Nov 2026
# The k6 pod's memory limit, in MiB: the most it can take from a node, and
# part of the free memory rollout-no-drop.sh asks a node for
K6_MEMORY_LIMIT_MI=512

die() {
  echo "$(basename "$0"): $*" >&2
  exit 1
}

# "90s" -> 90; anything else is refused
seconds_of() {
  [[ "$1" =~ ^([1-9][0-9]*)s$ ]] || die "duration '$1' must be whole seconds such as 90s"
  echo "${BASH_REMATCH[1]}"
}

# Starts the Job and returns once its pod is running
k6_start() {  # namespace job script-file KEY=VALUE...
  local ns=$1 name=$2 file=$3 kv envs="" phase="" _
  shift 3
  for kv in "$@"; do
    [[ "$kv" =~ ^[A-Z_]+=[A-Za-z0-9:/._%-]+$ ]] || die "k6 setting '$kv' has characters this script does not pass through"
    envs+="            - {name: ${kv%%=*}, value: \"${kv#*=}\"}"$'\n'
  done
  kubectl -n "$ns" delete job "$name" --ignore-not-found --wait=true >/dev/null
  kubectl -n "$ns" create configmap "$name" --from-file=script.js="$file" --dry-run=client -o yaml \
    | kubectl apply -f - >/dev/null
  kubectl apply -f - >/dev/null <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $name
  namespace: $ns
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels: {app: k6}
    spec:
      restartPolicy: Never
      containers:
        - name: k6
          image: $K6_IMAGE
          args: [run, --quiet, /scripts/script.js]
          env:
$envs
          volumeMounts: [{name: script, mountPath: /scripts}]
          resources:
            requests: {cpu: 200m, memory: 128Mi}
            limits: {cpu: "1", memory: ${K6_MEMORY_LIMIT_MI}Mi}
      volumes: [{name: script, configMap: {name: $name}}]
EOF
  for _ in $(seq 1 60); do
    phase=$(kubectl -n "$ns" get pods -l "job-name=$name" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
    case "$phase" in
      Running) return 0 ;;
      Succeeded|Failed) die "k6 job $name ended before the test started ($phase): kubectl -n $ns logs job/$name" ;;
    esac
    sleep 3
  done
  die "k6 job $name did not start within 3 minutes: kubectl -n $ns describe job $name"
}

# Done, Running or Failed
k6_state() {  # namespace job
  local ok bad
  # An unreadable Job is Unknown, never Running: callers need Running to mean
  # "the load is still on", and a kubectl error must not prove that
  ok=$(kubectl -n "$1" get job "$2" -o jsonpath='{.status.succeeded}') || { echo Unknown; return 0; }
  bad=$(kubectl -n "$1" get job "$2" -o jsonpath='{.status.failed}') || { echo Unknown; return 0; }
  if [ "${ok:-0}" -ge 1 ]; then echo Done
  elif [ "${bad:-0}" -ge 1 ]; then echo Failed
  else echo Running
  fi
}

# Waits for the Job and prints its log; fails if k6 itself failed
k6_wait() {  # namespace job seconds
  local state _
  for _ in $(seq 1 $(( $3 / 5 + 1 ))); do
    state=$(k6_state "$1" "$2")
    [ "$state" = Running ] || break
    sleep 5
  done
  # Logs first, even for a Job that did not finish: they say why. Returns
  # instead of dying, because the caller captures this output and a die inside
  # $(...) would throw the logs away
  kubectl -n "$1" logs "job/$2" || true
  if [ "$state" != Done ]; then
    echo "k6 job $2 is $state, not Done" >&2
    return 1
  fi
}

# The nodes as the cluster reports them, whatever their number or size (the
# cluster rebuilt on 11 November is not the two 2 GB nodes of the first one):
# "name instance-type allocatable" per line, from kubectl get nodes
nodes_raw() {
  kubectl get nodes --no-headers \
    -o 'custom-columns=N:.metadata.name,T:.metadata.labels.node\.kubernetes\.io/instance-type,M:.status.allocatable.memory'
}

# Kubernetes quantity (3074892Ki, 1.6Gi, 1200Mi, plain bytes) to whole MiB,
# rounded down (capacity) or, with up set, rounded up (usage), so rounding never
# adds room;
# -1 for anything else, so an unreadable figure is never taken for a number
MIB_AWK='function mib(s, up,  n, u, f, v) {
  if (s !~ /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|k|M|G|T)?$/) return -1
  n = s; sub(/[A-Za-z]+$/, "", n); u = substr(s, length(n) + 1)
  f = u == "Ki" ? 1024 : u == "Mi" ? 1048576 : u == "Gi" ? 1073741824 : u == "Ti" ? 1099511627776 : \
      u == "k" ? 1000 : u == "M" ? 1000000 : u == "G" ? 1000000000 : u == "T" ? 1000000000000 : 1
  v = n * f / 1048576
  if (v >= 1000000000) return -1   # past 1 PiB: not a real figure, and awk would print an exponent
  return (up && v > int(v)) ? int(v) + 1 : int(v)
}'

# "2 (a s-2vcpu-4gb 3002 MiB allocatable, b ...)"; "unreadable" if kubectl fails
node_shape() {
  local raw
  raw=$(nodes_raw 2>/dev/null) || { echo unreadable; return 0; }
  printf '%s\n' "$raw" | awk "$MIB_AWK"'
    NF >= 3 { m = mib($3); n++
              list = list sep $1 " " $2 " " (m < 0 ? "allocatable unreadable (" $3 ")" : m " MiB allocatable"); sep = ", " }
    END { if (n) print n " (" list ")"; else print "unreadable" }'
}

# Free memory per node (allocatable minus kubectl top's usage), one line each:
# "ok name MiB", or "unknown name" when that node's usage or allocatable cannot
# be read (metrics not ready, <unknown>, missing from kubectl top, a unit it
# does not know). An unreadable node is never counted as empty, and it does
# not stop the other nodes being checked. Prints nothing if the nodes cannot
# be listed at all
node_free_report() {
  local raw top
  raw=$(nodes_raw 2>/dev/null) || return 0
  top=$(kubectl top nodes --no-headers 2>/dev/null) || top=""
  printf '%s\n--\n%s\n' "$raw" "$top" | awk "$MIB_AWK"'
    $0 == "--" { part = 2; next }
    part != 2 && NF >= 3 { alloc[$1] = mib($3); names[++n] = $1; next }
    part == 2 && NF >= 4 { used[$1] = mib($4, 1) }
    END {
      for (i = 1; i <= n; i++) {
        k = names[i]
        if (alloc[k] < 0 || !(k in used) || used[k] < 0) print "unknown " k
        else print "ok " k " " (alloc[k] - used[k])
      }
    }'
}

# A memory limit from kubectl in whole MiB, rounded up (it is added to what a
# node must have free), or nothing if unreadable
quantity_mib() {
  printf '%s\n' "$1" | awk "$MIB_AWK"' { m = mib($1, 1); if (m >= 0) print m }'
}

# Node autoscaling bounds from the cluster autoscaler's status ConfigMap
# (DOKS publishes it in kube-system): "min 1, max 2", one entry per node
# group joined by "; "; nothing when it cannot be read
autoscaler_bounds() {
  kubectl -n kube-system get configmap cluster-autoscaler-status -o 'jsonpath={.data.status}' 2>/dev/null \
    | awk 'function flush() { if (mn != "" && mx != "") { out = out sep "min " mn ", max " mx; sep = "; " } mn = mx = "" }
           /^- / { flush() }
           $1 == "minSize:" { mn = $2 }
           $1 == "maxSize:" { mx = $2 }
           END { flush(); if (out) print out }'
}

# A number from the RESULT line: result_field "$line" failures
result_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p"
}
