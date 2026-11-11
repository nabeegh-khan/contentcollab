#!/usr/bin/env bash
# Creates or updates the app Secret (app-secrets) in the current cluster without a file that holds
# its values (#53; SEC-1, SEC-10). Each value comes from the environment, from the Secret already in
# the cluster, from a prompt (the Spaces key, when run in a terminal) or is generated; nothing is
# printed or passed as an argument. It is applied over stdin by server-side apply: client-side
# `kubectl apply` would keep every value in plain text in the last-applied-configuration annotation.
#
#   read -rs SPACES_SECRET && export SPACES_SECRET     # so it stays out of the shell history
#   SPACES_KEY=... scripts/app-secret.sh
#
# Settings: NAMESPACE (contentcollab), SECRET_NAME (app-secrets), KUBE_CONTEXT (the current one),
# RESTART=1 (restart api and worker afterwards; they read the Secret only when they start).
# Values: DB_USER, DB_PASSWORD, JWT_SECRET, SPACES_KEY, SPACES_SECRET. A value given here wins; one
# left out is kept from the existing Secret, else generated (DB_PASSWORD, JWT_SECRET), defaulted
# (DB_USER) or left empty (the Spaces keys). A new DB_PASSWORD would not match the one PostgreSQL
# stored when its volume was first initialised, so an existing one is never regenerated.
set -euo pipefail

: "${NAMESPACE:=contentcollab}"
: "${SECRET_NAME:=app-secrets}"
: "${KUBE_CONTEXT:=}"
: "${RESTART:=}"

command -v kubectl >/dev/null || { echo "missing: kubectl"; exit 1; }
kc() { if [ -n "$KUBE_CONTEXT" ]; then kubectl --context "$KUBE_CONTEXT" "$@"; else kubectl "$@"; fi; }

# check <KEY> <value> <min length>: the value goes inside double quotes in YAML, so no quote,
# backslash, space or newline; and never the template's placeholder
check() {
  [ "$2" != "REPLACE_ME" ] || { echo "$1 is still the template placeholder"; exit 1; }
  [[ "$2" =~ ^[A-Za-z0-9+/=._-]+$ ]] || { echo "$1 has characters other than letters, digits and + / = . _ - : check what was pasted"; exit 1; }
  [ "${#2}" -ge "$3" ] || { echo "$1 must be at least $3 characters"; exit 1; }
}
random_hex() { od -An -vtx1 -N"$1" /dev/urandom | tr -d ' \n'; }

# 1. Values given in the environment are checked before the cluster is touched
for spec in DB_USER:1 DB_PASSWORD:16 JWT_SECRET:32 SPACES_KEY:1 SPACES_SECRET:1; do
  key=${spec%%:*}
  [ -z "${!key:-}" ] || check "$key" "${!key}" "${spec##*:}"
done

# 2. The target, shown before anything changes
context=${KUBE_CONTEXT:-$(kc config current-context)}
echo "Target: context $context, namespace $NAMESPACE, Secret $SECRET_NAME"
if ! out=$(kc get namespace "$NAMESPACE" 2>&1); then
  echo "$out"
  echo "namespace $NAMESPACE is not there: kubectl apply -f k8s/base/namespace.yaml"
  exit 1
fi
# Only NotFound means "new": any other error (no permission, no connection) must not end in a
# freshly generated database password
if out=$(kc -n "$NAMESPACE" get secret "$SECRET_NAME" -o name 2>&1); then
  exists=true
elif printf '%s' "$out" | grep -q NotFound; then
  exists=false
else
  echo "cannot read $SECRET_NAME: $out"
  exit 1
fi

# 3. One value per key: environment, then the cluster, then a prompt, then a default
resolve() { # resolve <KEY> <min length> <user|random24|random32|prompt>
  local key=$1 value="${!1:-}" source="from the environment"
  if [ -z "$value" ]; then
    source="kept (already in the cluster)"
    if [ "$exists" = true ]; then value=$(kc -n "$NAMESPACE" get secret "$SECRET_NAME" -o "jsonpath={.data.$key}" | base64 -d); fi
  fi
  if [ -z "$value" ] && [ "$3" = prompt ] && [ -t 0 ]; then
    read -rsp "$key: " value; echo >&2
    [ -z "$value" ] || check "$key" "$value" "$2"
    source="typed"
  fi
  if [ -z "$value" ]; then
    case "$3" in
      user) value=contentcollab; source="default" ;;
      random24) value=$(random_hex 24); source="generated" ;;
      random32) value=$(random_hex 32); source="generated" ;;
      prompt) source="empty"; echo "$key is empty: uploads fail until it is set" ;;
    esac
  fi
  printf -v "V_$key" '%s' "$value"
  printf -v "S_$key" '%s' "$source"
}
resolve DB_USER 1 user
resolve DB_PASSWORD 16 random24
resolve JWT_SECRET 32 random32
resolve SPACES_KEY 1 prompt
resolve SPACES_SECRET 1 prompt

# 4. Over stdin (printf is a shell builtin), so no value is in a process argument list
printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\ntype: Opaque\nstringData:\n  DB_USER: "%s"\n  DB_PASSWORD: "%s"\n  JWT_SECRET: "%s"\n  SPACES_KEY: "%s"\n  SPACES_SECRET: "%s"\n' \
  "$SECRET_NAME" "$NAMESPACE" "$V_DB_USER" "$V_DB_PASSWORD" "$V_JWT_SECRET" "$V_SPACES_KEY" "$V_SPACES_SECRET" \
  | kc apply --server-side --force-conflicts --field-manager=app-secret -f - >/dev/null
# A Secret first made with client-side apply carries the plain-text copy; remove it
if [ "$exists" = true ]; then
  kc -n "$NAMESPACE" annotate secret "$SECRET_NAME" kubectl.kubernetes.io/last-applied-configuration- >/dev/null
fi

for key in DB_USER DB_PASSWORD JWT_SECRET SPACES_KEY SPACES_SECRET; do
  source_var="S_$key"; echo "  $key: ${!source_var}"
done
echo "Applied $SECRET_NAME in $NAMESPACE."

# 5. Running pods keep the values they started with
if [ "$exists" = true ]; then
  if [ "$RESTART" = 1 ]; then
    for deployment in api worker; do
      if kc -n "$NAMESPACE" get deployment "$deployment" >/dev/null 2>&1; then
        kc -n "$NAMESPACE" rollout restart "deployment/$deployment"
        kc -n "$NAMESPACE" rollout status "deployment/$deployment" --timeout=180s
      fi
    done
  else
    echo "api and worker read the Secret when they start: RESTART=1 $0, or kubectl -n $NAMESPACE rollout restart deployment/api deployment/worker"
  fi
fi
