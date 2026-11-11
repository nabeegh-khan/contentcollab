# Runs a k6 script as a Kubernetes Job in the cluster kubectl points at (#69).
# Inside the cluster the load goes through the Service and kube-proxy, as real
# traffic does; a port-forward would pin it to one pod. Nothing is installed on
# the machine running the script. Sourced, not run.
# shellcheck shell=bash

: "${K6_IMAGE:=grafana/k6:2.3.0}"   # github.com/grafana/k6/releases, checked 11 Nov 2026

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
            limits: {cpu: "1", memory: 512Mi}
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
  ok=$(kubectl -n "$1" get job "$2" -o jsonpath='{.status.succeeded}')
  bad=$(kubectl -n "$1" get job "$2" -o jsonpath='{.status.failed}')
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
  kubectl -n "$1" logs "job/$2"
  [ "$state" = Done ] || die "k6 job $2 is $state, not Done"
}

# A number from the RESULT line: result_field "$line" failures
result_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p"
}
