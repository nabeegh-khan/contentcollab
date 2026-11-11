#!/usr/bin/env bash
# Brings up the DigitalOcean Kubernetes cluster and everything the doks overlay
# expects, or brings a running one up to date: the Gateway API CRDs, NGINX
# Gateway Fabric, cert-manager with a Let's Encrypt issuer, the app Secret and
# the app. Every step can be re-run (INF-3). DRY_RUN=1 makes every check and
# prints each change instead of making it; it may save the cluster's
# credentials to the local kubeconfig so it can read what is installed.
# Design, versions and sources: docs/ARCHITECTURE.md D13.
#
# Needs: doctl (signed in with `doctl auth init`), kubectl, helm, curl; gh to
# check the CI token.
# Creates billable resources: two US$18 nodes and one US$12 load balancer,
# about US$48 a month for the cluster alone; US$54 with Spaces and the database
# volume (docs/ARCHITECTURE.md). Each node the autoscaler adds above NODE_COUNT
# (up to NODE_MAX) bills at the node size's price while it runs.
# Run `scripts/cluster-down.sh` after grading (INF-7).
set -euo pipefail
cd "$(dirname "$0")/.."   # paths below are relative to the repository root
# shellcheck source=scripts/lib/cluster-up-lib.sh
. scripts/lib/cluster-up-lib.sh

: "${CLUSTER_NAME:=contentcollab}"
: "${REGION:=tor1}"
: "${NODE_SIZE:=s-2vcpu-2gb}"   # smallest size that runs two api pods plus postgres comfortably
: "${NODE_COUNT:=2}"
: "${NODE_MIN:=$NODE_COUNT}"      # autoscaling bounds; defaults keep the pool at NODE_COUNT (D13)
: "${NODE_MAX:=$NODE_COUNT}"
: "${K8S_MINOR:=1.36}"          # new clusters only: the newest minor cert-manager 1.21 supports (D13)
: "${LETSENCRYPT_EMAIL:=}"
: "${SECRETS_FILE:=k8s/base/secrets.yaml}"   # git-ignored copy of secrets.example.yaml with real values
: "${CERT_TIMEOUT:=300}"                      # seconds to wait for the certificate once DNS points here
: "${DRY_RUN:=0}"
: "${DATADOG_API_KEY:=}"                      # optional: empty skips the Datadog agent
: "${DATADOG_SITE:=datadoghq.com}"            # the account's site: datadoghq.eu, us3.datadoghq.com, ...
DOMAIN=contentcollab.app                      # the hostname in k8s/doks/gateway.yaml

# Checked 11 November 2026 (D13)
NGF_VERSION="v2.8.1"            # https://docs.nginx.com/nginx-gateway-fabric/install/helm/
CERT_MANAGER_VERSION="v1.21.3"  # https://cert-manager.io/docs/releases/
CERT_MANAGER_STEPS="v1.20.5"    # latest patch of each minor between an older install and the pin
DATADOG_CHART_VERSION="3.269.1" # https://github.com/DataDog/helm-charts/blob/main/charts/datadog/Chart.yaml (8 Nov 2026)

# 0. Nothing changes until the variables, the tools and the sign-in check out
validate_env
require_tools doctl kubectl helm curl
require_doctl_auth
if [ "$DRY_RUN" = 1 ]; then echo "DRY_RUN=1: checks run, changes are printed, nothing is changed"; fi

# 1. Cluster: created once, at a pinned version; later runs find it and move on
version=$(cluster_version "$CLUSTER_NAME")
if [ -z "$version" ]; then
  slug=$(newest_slug "$K8S_MINOR")
  [ -n "$slug" ] || die "DOKS offers no $K8S_MINOR.x version now (doctl kubernetes options versions): update K8S_MINOR and D13"
  echo "Creating cluster $CLUSTER_NAME in $REGION, Kubernetes $slug"
  # --ha=false is explicit: with --ha omitted the API turns the US$40 a month high-availability control plane on for
  # Kubernetes 1.36.0 and later, and it cannot be turned off again (DigitalOcean doctl reference and HA how-to, checked 11 Nov 2026; D13)
  run doctl kubernetes cluster create "$CLUSTER_NAME" \
    --region "$REGION" \
    --version "$slug" \
    --ha=false \
    --node-pool "name=default;size=$NODE_SIZE;count=$NODE_COUNT;auto-scale=true;min-nodes=$NODE_MIN;max-nodes=$NODE_MAX" \
    --wait
else
  echo "Cluster $CLUSTER_NAME exists, Kubernetes $version: not recreated"
  if [ "$(minor_of "$version")" -gt "$(minor_of "$K8S_MINOR")" ]; then
    echo "warning: Kubernetes $version is above $K8S_MINOR, the newest minor cert-manager $CERT_MANAGER_VERSION supports; kept (D13)"
  fi
fi
# Reading the cluster needs its credentials, which a dry run has only when
# the cluster already exists
can_read=1
if [ -n "$version" ] || [ "$DRY_RUN" = 0 ]; then
  doctl kubernetes cluster kubeconfig save "$CLUSTER_NAME"   # local kubeconfig only
  kubectl get nodes
else
  can_read=0
fi

# 2. Gateway API CRDs (standard channel, the bundle NGF ships) and the NGINX
#    controller. Creating a Gateway later makes the controller provision a
#    DigitalOcean load balancer in front of it.
kubectl kustomize "https://github.com/nginx/nginx-gateway-fabric/config/crd/gateway-api/standard?ref=$NGF_VERSION" \
  | run_stdin kubectl apply -f -
run helm upgrade --install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric \
  --version "${NGF_VERSION#v}" --create-namespace -n nginx-gateway \
  --set nginxGateway.productTelemetry.enable=false # vendor usage reporting; unused, and its export fails (BUILD_LOG.md)

# 3. cert-manager with Gateway API support, so the HTTP-01 challenge is
#    answered through an HTTPRoute instead of an Ingress. An older install
#    moves one minor version at a time; --wait so each step is up before the next
installed=""
if [ "$can_read" = 1 ]; then installed=$(installed_chart_version cert-manager cert-manager); fi
# shellcheck disable=SC2086 # CERT_MANAGER_STEPS is a space-separated list
steps=$(cert_manager_steps "$installed" "$CERT_MANAGER_VERSION" $CERT_MANAGER_STEPS)
for v in $steps; do
  echo "cert-manager ${installed:-not installed} -> $v"
  run helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
    --version "$v" --create-namespace -n cert-manager \
    --set crds.enabled=true \
    --set config.apiVersion=controller.config.cert-manager.io/v1alpha1 \
    --set config.kind=ControllerConfiguration \
    --set "$(cert_manager_gateway_flag "$v")" \
    --wait --timeout 5m
  installed=$v
done
if [ "$DRY_RUN" = 0 ]; then
  for d in cert-manager cert-manager-cainjector cert-manager-webhook; do
    # The webhook comes up after the controller; applying the issuer before it
    # answers fails the first run (cert-manager docs, "Verifying the installation")
    kubectl -n cert-manager rollout status "deployment/$d" --timeout=120s
  done
fi

# 4. Namespace, Secret, issuer, then the application
run kubectl apply -f k8s/base/namespace.yaml
run kubectl apply -f "$SECRETS_FILE"
# | delimiter; validate_env keeps & | / out of the address
sed "s|LETSENCRYPT_EMAIL|$LETSENCRYPT_EMAIL|" k8s/doks/cluster-issuer.yaml | run_stdin kubectl apply -f -
# 4b. The application, pinned to an image CI built, never :latest (INF-9;
#     L8 p67, p73). IMAGE_TAG defaults to the newest commit on main that
#     deploy.yml builds for (its on.push.paths: api, worker, k8s and the
#     workflow); the registry is checked before anything applies.
if [ -z "${IMAGE_TAG:-}" ]; then
  git fetch -q origin main
  IMAGE_TAG=$(git log -1 --format=%H origin/main -- api worker k8s .github/workflows/deploy.yml)
  [ -n "$IMAGE_TAG" ] || die "no commit on origin/main touches api, worker or k8s: set IMAGE_TAG"
fi
rendered=$(kubectl kustomize k8s/doks | sed "s#\(ghcr.io/nabeegh-khan/contentcollab-[a-z]*\):latest#\1:$IMAGE_TAG#g")
for repo in $(printf '%s\n' "$rendered" | grep -o 'ghcr.io/nabeegh-khan/contentcollab-[a-z]*' | sort -u); do
  name=${repo#ghcr.io/}
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:$name:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/$name/manifests/$IMAGE_TAG")
  [ "$code" = "200" ] || die "no image $repo:$IMAGE_TAG in the registry (HTTP $code); set IMAGE_TAG to a commit deploy.yml built"
done
printf '%s\n' "$rendered" | run_stdin kubectl apply -f -
if [ "$DRY_RUN" = 0 ]; then
  for d in api worker; do kubectl -n contentcollab rollout status "deployment/$d" --timeout=180s; done
fi

# 5. Where the world reaches it. The Gateway's address is the load balancer;
#    an A record for the domain at the registrar points there. The certificate
#    can be issued only once it does, so it is waited for only then (D13).
cert_failed=0
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY-RUN: wait for the Gateway address, check $DOMAIN resolves to it, wait up to ${CERT_TIMEOUT}s for certificate/contentcollab-tls"
else
  echo "Waiting for the Gateway address (load balancer provisioning takes a few minutes)"
  addr=""
  for _ in $(seq 1 30); do
    addr=$(gateway_address)
    [ -n "$addr" ] && break
    sleep 10
  done
  if [ -z "$addr" ]; then
    echo "Gateway address not assigned yet: kubectl -n contentcollab get gateway; re-run this script once it is"
  else
    echo "Gateway address: $addr"
    reached=$(reached_address "$DOMAIN")
    if [ "$reached" != "$addr" ]; then
      echo "Next: A record $DOMAIN -> $addr at the registrar ($DOMAIN reaches ${reached:-nothing} now)."
      echo "Re-run this script once it resolves, to wait for the certificate."
    elif wait_certificate contentcollab contentcollab-tls "$CERT_TIMEOUT"; then
      echo "Certificate ready: https://$DOMAIN"
    else
      cert_failed=1   # reported last, after the Datadog step
    fi
  fi
fi
check_ci_token
echo "Set the repository variable SMOKE_URL to https://$DOMAIN once the certificate is ready"

# 6. Datadog agent (#27), only when an API key is in the environment. Last, so
#    the app and the Gateway address never wait on it or fail with it. The key
#    goes into a Secret; the chart reads it from there (SEC-1).
if [ -n "$DATADOG_API_KEY" ]; then
  # The key is sent to api.$DATADOG_SITE below, so the site must be one of
  # Datadog's own (docs.datadoghq.com/getting_started/site, 10 Nov 2026); the
  # key goes inside double quotes in YAML, so letters and digits only
  case "$DATADOG_SITE" in
    datadoghq.com|us3.datadoghq.com|us5.datadoghq.com|datadoghq.eu|ddog-gov.com|us2.ddog-gov.com|ap1.datadoghq.com|ap2.datadoghq.com|uk1.datadoghq.com) ;;
    *) die "DATADOG_SITE '$DATADOG_SITE' is not a Datadog site (datadoghq.com, datadoghq.eu, us3.datadoghq.com, ...)" ;;
  esac
  [[ "$DATADOG_API_KEY" =~ ^[A-Za-z0-9]+$ ]] || die "DATADOG_API_KEY has characters other than letters and digits: check what was pasted"
  # A wrong key or site would otherwise install cleanly and send nothing.
  # 200 = valid, 403 = invalid (GET /api/v1/validate, Datadog API spec)
  code=$(printf 'DD-API-KEY: %s\n' "$DATADOG_API_KEY" | curl -s --max-time 15 -o /dev/null -w '%{http_code}' -H @- \
    "https://api.$DATADOG_SITE/api/v1/validate" || true)   # 000 when the site is unreachable
  [ "$code" = "200" ] || die "Datadog rejected DATADOG_API_KEY at api.$DATADOG_SITE (HTTP $code): check the key and DATADOG_SITE"
  kubectl create namespace datadog --dry-run=client -o yaml | run_stdin kubectl apply -f -
  # On a re-run the agents read the key from the Secret only when they start,
  # and helm leaves them running when the values are unchanged; so every re-run
  # restarts them (a short gap in agent data), whether or not the key changed
  agent_installed=false
  if [ "$can_read" = 1 ] && helm status datadog-agent -n datadog >/dev/null 2>&1; then agent_installed=true; fi
  # Through stdin (printf is a shell builtin), so the key is never in a
  # process argument list; works the same in Git Bash on Windows. Server-side
  # apply under its own field manager: with kubectl's default manager the
  # last-applied-configuration annotation, a second copy, is still written
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: datadog-secret\n  namespace: datadog\nstringData:\n  api-key: "%s"\n' "$DATADOG_API_KEY" \
    | run_stdin kubectl apply --server-side --field-manager=cluster-up -f -
  run helm upgrade --install datadog-agent datadog --repo https://helm.datadoghq.com \
    --version "$DATADOG_CHART_VERSION" -n datadog -f k8s/doks/datadog-values.yaml \
    --set datadog.site="$DATADOG_SITE" --wait --timeout 5m
  if [ "$agent_installed" = true ]; then
    run kubectl -n datadog rollout restart daemonset/datadog-agent deployment/datadog-agent-cluster-agent
    if [ "$DRY_RUN" = 0 ]; then
      kubectl -n datadog rollout status daemonset/datadog-agent --timeout=300s
      kubectl -n datadog rollout status deployment/datadog-agent-cluster-agent --timeout=300s
    fi
  fi
else
  echo "DATADOG_API_KEY not set: Datadog agent not installed (#27)"
fi

[ "$cert_failed" = 0 ] || die "the certificate for $DOMAIN was not issued: cert-manager's status is above (D13)"
