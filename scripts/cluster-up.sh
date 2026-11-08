#!/usr/bin/env bash
# Brings up the DigitalOcean Kubernetes cluster and everything the doks overlay
# expects: the Gateway API CRDs, NGINX Gateway Fabric, cert-manager with a
# Let's Encrypt issuer, and the app Secret. Repeatable: every step is
# idempotent, so re-running after a failure is safe (INF-3).
#
# Needs: doctl (authenticated with `doctl auth init`), kubectl, helm.
# Creates billable resources: two US$18 nodes and one US$12 load balancer,
# about US$48 a month for the cluster alone; US$54 with Spaces and the database
# volume (docs/ARCHITECTURE.md). Run `scripts/cluster-down.sh` after grading (INF-7).
set -euo pipefail
cd "$(dirname "$0")/.."   # paths below are relative to the repository root

: "${CLUSTER_NAME:=contentcollab}"
: "${REGION:=tor1}"
: "${NODE_SIZE:=s-2vcpu-2gb}"   # smallest size that runs two api pods plus postgres comfortably
: "${NODE_COUNT:=2}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL to the address Lets Encrypt notifies about expiry}"
: "${SECRETS_FILE:=k8s/base/secrets.yaml}"   # git-ignored copy of secrets.example.yaml with real values
: "${DATADOG_API_KEY:=}"                      # optional: empty skips the Datadog agent
: "${DATADOG_SITE:=datadoghq.com}"            # the account's site: datadoghq.eu, us3.datadoghq.com, ...

NGF_VERSION="v2.8.0"            # https://docs.nginx.com/nginx-gateway-fabric/install/helm/
CERT_MANAGER_VERSION="v1.19.2"  # https://cert-manager.io/docs/installation/helm/
DATADOG_CHART_VERSION="3.269.1" # https://github.com/DataDog/helm-charts/blob/main/charts/datadog/Chart.yaml (8 Nov 2026)

for tool in doctl kubectl helm; do
  command -v "$tool" >/dev/null || { echo "missing: $tool"; exit 1; }
done
[ -f "$SECRETS_FILE" ] || { echo "missing $SECRETS_FILE: copy k8s/base/secrets.example.yaml and fill in real values"; exit 1; }

# 1. Cluster: created once; later runs find it and move on
if ! doctl kubernetes cluster get "$CLUSTER_NAME" >/dev/null 2>&1; then
  doctl kubernetes cluster create "$CLUSTER_NAME" \
    --region "$REGION" \
    --node-pool "name=default;size=$NODE_SIZE;count=$NODE_COUNT" \
    --wait
fi
# Writes the cluster's credentials into ~/.kube/config and selects it
doctl kubernetes cluster kubeconfig save "$CLUSTER_NAME"
kubectl get nodes

# 2. Gateway API CRDs (standard channel) and the NGINX controller.
#    Creating a Gateway later makes the controller provision a DigitalOcean
#    load balancer in front of it.
kubectl kustomize "https://github.com/nginx/nginx-gateway-fabric/config/crd/gateway-api/standard?ref=$NGF_VERSION" | kubectl apply -f -
helm upgrade --install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric \
  --version "${NGF_VERSION#v}" --create-namespace -n nginx-gateway \
  --set nginxGateway.productTelemetry.enable=false # vendor usage reporting; unused, and its export fails (BUILD_LOG.md)

# 3. cert-manager, with Gateway API support so the HTTP-01 challenge can be
#    answered through an HTTPRoute instead of an Ingress
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --version "$CERT_MANAGER_VERSION" --create-namespace -n cert-manager \
  --set crds.enabled=true \
  --set config.apiVersion=controller.config.cert-manager.io/v1alpha1 \
  --set config.kind=ControllerConfiguration \
  --set config.enableGatewayAPI=true
for d in cert-manager cert-manager-cainjector cert-manager-webhook; do
  # The webhook comes up after the controller; applying the issuer before it
  # answers fails the first run (cert-manager docs, "Verifying the installation")
  kubectl -n cert-manager rollout status "deployment/$d" --timeout=120s
done

# 4. Namespace, Secret, issuer, then the application
kubectl apply -f k8s/base/namespace.yaml
kubectl apply -f "$SECRETS_FILE"
sed "s|LETSENCRYPT_EMAIL|$LETSENCRYPT_EMAIL|" k8s/doks/cluster-issuer.yaml | kubectl apply -f -   # | delimiter: an address may contain & or /
# 4b. The application, pinned to an image CI built, never :latest (INF-9;
#     L8 p67, p73). IMAGE_TAG defaults to the newest commit on main that
#     deploy.yml builds for; the registry is checked before anything applies.
git fetch -q origin main
: "${IMAGE_TAG:=$(git log -1 --format=%H origin/main -- api k8s .github/workflows/deploy.yml)}"
rendered=$(kubectl kustomize k8s/doks | sed "s#\(ghcr.io/nabeegh-khan/contentcollab-[a-z]*\):latest#\1:$IMAGE_TAG#g")
for repo in $(printf '%s\n' "$rendered" | grep -o 'ghcr.io/nabeegh-khan/contentcollab-[a-z]*' | sort -u); do
  name=${repo#ghcr.io/}
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:$name:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/$name/manifests/$IMAGE_TAG")
  [ "$code" = "200" ] || { echo "no image $repo:$IMAGE_TAG in the registry (HTTP $code); set IMAGE_TAG to a commit deploy.yml built"; exit 1; }
done
printf '%s\n' "$rendered" | kubectl apply -f -
kubectl -n contentcollab rollout status deployment/api --timeout=180s

# 5. Where the world reaches it. The Gateway's address is the load balancer;
#    an A record for contentcollab.app at the registrar points there.
echo "Waiting for the Gateway address (load balancer provisioning takes a few minutes)"
for _ in $(seq 1 30); do
  addr=$(kubectl -n contentcollab get gateway contentcollab -o jsonpath='{.status.addresses[0].value}' 2>/dev/null || true)
  [ -n "$addr" ] && break
  sleep 10
done
if [ -z "$addr" ]; then
  echo "Gateway address not assigned yet: kubectl -n contentcollab get gateway"
else
  echo "Gateway address: $addr"
  echo "Next: A record contentcollab.app to $addr at the registrar. The certificate is issued on the first HTTPS request."
fi
echo "For CI rollouts: deploy.yml reads the repository secret KUBECONFIG (base64 of the kubeconfig) today; #76 replaces it with DIGITALOCEAN_ACCESS_TOKEN. Set the variable SMOKE_URL once DNS and TLS work"

# 6. Datadog agent (#27), only when an API key is in the environment. Last, so
#    the app and the Gateway address never wait on it or fail with it. The key
#    goes into a Secret; the chart reads it from there (SEC-1).
if [ -n "$DATADOG_API_KEY" ]; then
  # A wrong key or site would otherwise install cleanly and send nothing.
  # 200 = valid, 403 = invalid (GET /api/v1/validate, Datadog API spec)
  code=$(printf 'DD-API-KEY: %s\n' "$DATADOG_API_KEY" | curl -s -o /dev/null -w '%{http_code}' -H @- \
    "https://api.$DATADOG_SITE/api/v1/validate" || true)   # 000 when the site is unreachable
  [ "$code" = "200" ] || { echo "Datadog rejected DATADOG_API_KEY at api.$DATADOG_SITE (HTTP $code): check the key and DATADOG_SITE"; exit 1; }
  kubectl create namespace datadog --dry-run=client -o yaml | kubectl apply -f -
  # Through stdin (printf is a shell builtin), so the key is never in a
  # process argument list; works the same in Git Bash on Windows
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: datadog-secret\n  namespace: datadog\nstringData:\n  api-key: "%s"\n' "$DATADOG_API_KEY" \
    | kubectl apply -f -
  helm upgrade --install datadog-agent datadog --repo https://helm.datadoghq.com --version "$DATADOG_CHART_VERSION" -n datadog -f k8s/doks/datadog-values.yaml --set datadog.site="$DATADOG_SITE" --wait --timeout 5m
else
  echo "DATADOG_API_KEY not set: Datadog agent not installed (#27)"
fi
