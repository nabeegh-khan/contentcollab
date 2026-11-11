# Functions for scripts/cluster-up.sh (#54, docs/ARCHITECTURE.md D13).
# Sourced, not run. One job each, so scripts/cluster-up.test.mjs can drive
# the script through stub tools.
# shellcheck shell=bash

die() {
  echo "cluster-up: $*" >&2
  exit 1
}

# Makes the change, or with DRY_RUN=1 prints it instead
run() {
  if [ "${DRY_RUN:-0}" = 1 ]; then
    printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# Same, for a command that reads a manifest on stdin
run_stdin() {
  if [ "${DRY_RUN:-0}" = 1 ]; then
    cat >/dev/null
    printf 'DRY-RUN:'; printf ' %q' "$@"; printf ' < rendered manifest\n'
  else
    "$@"
  fi
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || die "missing tool: $tool"
  done
}

# Every variable checked before anything changes (INF-3). The email goes
# into a sed replacement and to Let's Encrypt, so no & | / or spaces
validate_env() {
  [ -n "${LETSENCRYPT_EMAIL:-}" ] || die "set LETSENCRYPT_EMAIL to the address Let's Encrypt notifies about expiry"
  [[ "$LETSENCRYPT_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] \
    || die "LETSENCRYPT_EMAIL '$LETSENCRYPT_EMAIL' is not an email address"
  [[ "$CLUSTER_NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "CLUSTER_NAME '$CLUSTER_NAME': lowercase letters, digits and -"
  [[ "$REGION" =~ ^[a-z]{3}[0-9]$ ]] || die "REGION '$REGION' is not a DigitalOcean region slug such as tor1"
  [[ "$NODE_COUNT" =~ ^[1-9][0-9]*$ ]] || die "NODE_COUNT '$NODE_COUNT' is not a positive number"
  # Both go into a --node-pool spec or a sed replacement, where ; # & split them
  [[ "$NODE_SIZE" =~ ^[a-z0-9-]+$ ]] || die "NODE_SIZE '$NODE_SIZE' is not a droplet size slug such as s-2vcpu-2gb"
  [[ -z "${IMAGE_TAG:-}" || "$IMAGE_TAG" =~ ^[A-Za-z0-9_.-]+$ ]] || die "IMAGE_TAG '$IMAGE_TAG' is not an image tag (letters, digits, _ . -)"
  [[ "$K8S_MINOR" =~ ^1\.[0-9]+$ ]] || die "K8S_MINOR '$K8S_MINOR' is not a Kubernetes minor version such as 1.36"
  [[ "$CERT_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die "CERT_TIMEOUT '$CERT_TIMEOUT' is not a number of seconds"
  case "$DRY_RUN" in 0|1) ;; *) die "DRY_RUN '$DRY_RUN' must be 0 or 1" ;; esac
  [ -f "$SECRETS_FILE" ] || die "missing $SECRETS_FILE: copy k8s/base/secrets.example.yaml and fill in real values"
}

# A failed sign-in must never read as "no cluster" and lead to a create
require_doctl_auth() {
  doctl account get >/dev/null 2>&1 || die "doctl is not signed in: run doctl auth init"
}

# Kubernetes version slug of the named cluster; empty when there is none
cluster_version() {
  local list
  list=$(doctl kubernetes cluster list --format Name,Version --no-header) || die "could not list clusters"
  printf '%s\n' "$list" | awk -v name="$1" '$1 == name { print $2 }'
}

# Newest DOKS slug for a minor version: 1.36 -> 1.36.10-do.1. The command
# has no --format flag, so the first column of its table is read
newest_slug() {
  local table
  table=$(doctl kubernetes options versions) || die "could not list DOKS versions"
  printf '%s\n' "$table" | awk 'NR > 1 { print $1 }' \
    | { grep -E "^${1//./\\.}\.[0-9]+-do\.[0-9]+$" || true; } | sort -V | tail -n 1
}

# Minor number of v1.21.3, 1.37.0-do.2 or 1.36
minor_of() {
  local v=${1#v}
  v=${v#*.}
  echo "${v%%.*}"
}

# Chart version of an installed Helm release (v1.19.2); empty when absent
installed_chart_version() {  # release namespace
  local json
  # --all: a release stuck in pending-upgrade or failed still counts. A
  # failed listing must not read as "not installed" (that would skip steps)
  json=$(helm list -n "$2" --all --filter "^$1\$" -o json) \
    || die "helm list -n $2 failed, so the installed $1 version is unknown"
  printf '%s' "$json" | sed -n "s/.*\"chart\":\"$1-v\{0,1\}\([0-9][0-9.]*\)\".*/v\1/p"
}

# cert-manager versions to install, in order. A fresh cluster goes straight
# to the target; an installed one moves one minor version at a time through
# the given steps (cert-manager upgrade guide) and refuses a gap
cert_manager_steps() {  # installed target step...
  local installed=$1 target=$2 v prev
  shift 2
  if [ -z "$installed" ]; then echo "$target"; return; fi
  # Newer by any part, patch included, is refused: Helm would downgrade it
  if [ "$installed" != "$target" ] \
    && [ "$(printf '%s\n%s\n' "$installed" "$target" | sort -V | tail -n 1)" = "$installed" ]; then
    die "cert-manager $installed is newer than the pinned $target: update CERT_MANAGER_VERSION and D13"
  fi
  prev=$(minor_of "$installed")
  for v in "$@" "$target"; do
    [ "$(minor_of "$v")" -gt "$prev" ] || [ "$v" = "$target" ] || continue
    [ "$(minor_of "$v")" -le $((prev + 1)) ] \
      || die "no upgrade step from cert-manager $installed to $v: add the latest patch of each minor in between to CERT_MANAGER_STEPS"
    echo "$v"
    prev=$(minor_of "$v")
  done
}

# Gateway API switch: enableGatewayAPI up to 1.20, gatewayAPI.enabled from
# 1.21 (ControllerConfiguration types at v1.20.5 and v1.21.3)
cert_manager_gateway_flag() {
  if [ "$(minor_of "$1")" -ge 21 ]; then
    echo config.gatewayAPI.enabled=true
  else
    echo config.enableGatewayAPI=true
  fi
}

gateway_address() {
  kubectl -n contentcollab get gateway contentcollab -o jsonpath='{.status.addresses[0].value}' 2>/dev/null || true
}

# The address curl reaches for the domain, through the system resolver
reached_address() {
  curl -s -o /dev/null -w '%{remote_ip}' --max-time 10 "http://$1/health" 2>/dev/null || true
}

# Waits for cert-manager to issue the certificate; on failure prints its
# certificate, order and challenge status, where the reason is
wait_certificate() {  # namespace name seconds
  # cert-manager creates the Certificate from the Gateway's annotation
  if ! kubectl -n "$1" wait --for=create "certificate/$2" --timeout=60s >/dev/null; then
    echo "cert-manager did not create certificate/$2 within 60 s: check the Gateway's cert-manager.io/cluster-issuer annotation and the cert-manager logs (kubectl -n cert-manager logs deployment/cert-manager)" >&2
    return 1
  fi
  kubectl -n "$1" wait --for=condition=Ready "certificate/$2" --timeout="${3}s" && return 0
  echo "certificate $2 not issued within $3 s. cert-manager's status:" >&2
  kubectl -n "$1" get certificate,certificaterequest,order,challenge -o wide >&2 || true
  kubectl -n "$1" describe challenge >&2 || true
  return 1
}

# The deploy workflow mints a 600-second kubeconfig from this token (D13).
# Only checks and prints the command: the token is typed by its owner
check_ci_token() {
  local names
  if ! command -v gh >/dev/null || ! names=$(gh secret list 2>/dev/null); then
    echo "Could not read the repository secrets with gh. CI rollouts need DIGITALOCEAN_ACCESS_TOKEN: gh secret set DIGITALOCEAN_ACCESS_TOKEN"
  elif printf '%s\n' "$names" | cut -f1 | grep -qx DIGITALOCEAN_ACCESS_TOKEN; then
    echo "CI token present: DIGITALOCEAN_ACCESS_TOKEN"
  else
    echo "CI cannot roll out yet. Run: gh secret set DIGITALOCEAN_ACCESS_TOKEN (gh prompts for the token; D13)"
  fi
}
