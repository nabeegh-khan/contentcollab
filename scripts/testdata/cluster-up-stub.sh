#!/usr/bin/env bash
# Stand-in for doctl, kubectl, helm, curl, gh, git and sleep in
# scripts/cluster-up.test.mjs: logs its arguments to $STUB_DIR/calls.log and
# answers from STUB_* variables. Never calls the real tool.
tool=$(basename "$0")
printf '%s %s\n' "$tool" "$*" >> "$STUB_DIR/calls.log"
args=" $* "
case "$tool" in
  doctl)
    [ "${STUB_AUTH:-1}" = 1 ] || { echo "Error: Unable to authenticate you" >&2; exit 1; }
    case "$args" in
      *" cluster list "*) [ -z "${STUB_CLUSTER:-}" ] || echo "$STUB_CLUSTER" ;;
      *" cluster get "*) [ -n "${STUB_CLUSTER:-}" ] || { echo "Error: not found" >&2; exit 1; } ;;
      *" options versions "*)
        printf 'Slug            Kubernetes Version    Supported Features\n'
        printf '1.37.0-do.3     1.37.0                ha\n1.36.5-do.3     1.36.5                ha\n'
        printf '1.36.10-do.1    1.36.10               ha\n1.35.9-do.3     1.35.9                ha\n' ;;
    esac ;;
  kubectl)
    case "$args" in
      *" apply "*) cat >/dev/null ;;
      *" kustomize "*) printf 'kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - image: ghcr.io/nabeegh-khan/contentcollab-api:latest\n' ;;
      *" get gateway "*) printf '%s' "${STUB_GW_ADDR:-}" ;;
      *" wait "*"--for=condition=Ready"*) exit "${STUB_CERT_WAIT_RC:-0}" ;;
      *" get certificate,"*) echo "challenge/contentcollab-tls-1  pending  Waiting for HTTP-01 challenge propagation: wrong status code '404'" ;;
    esac ;;
  helm)
    case "$args" in
      *" list "*)
        if [ -z "${STUB_CM_INSTALLED:-}" ]; then echo '[]'
        else printf '[{"name":"cert-manager","namespace":"cert-manager","chart":"cert-manager-%s","app_version":"%s"}]\n' "$STUB_CM_INSTALLED" "$STUB_CM_INSTALLED"
        fi ;;
      *" status "*) exit 1 ;;
    esac ;;
  curl)
    case "$args" in
      *"ghcr.io/token"*) echo '{"token":"t"}' ;;
      *"/manifests/"*) printf 200 ;;
      *"remote_ip"*) printf '%s' "${STUB_DNS_IP:-}" ;;
      *) echo '{"status":"ok"}' ;;
    esac ;;
  gh)
    [ "${STUB_GH_OK:-1}" = 1 ] || exit 1
    for n in ${STUB_GH_NAMES:-}; do printf '%s\t2026-11-11T00:00:00Z\n' "$n"; done ;;
esac
exit 0
