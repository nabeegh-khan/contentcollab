#!/usr/bin/env bash
# Brings up the DigitalOcean Kubernetes cluster and everything the doks overlay
# expects: the Gateway API CRDs, NGINX Gateway Fabric, cert-manager with a
# Let's Encrypt issuer, and the app Secret. Repeatable: every step is
# idempotent, so re-running after a failure is safe (INF-3).
#
# Needs: doctl (authenticated with `doctl auth init`), kubectl, helm.
# Creates billable resources: two nodes and one load balancer (RESEARCH.md,
# about US$46 a month). Run `scripts/cluster-down.sh` after grading (INF-7).
set -euo pipefail

: "${CLUSTER_NAME:=contentcollab}"
: "${REGION:=tor1}"
: "${NODE_SIZE:=s-2vcpu-2gb}"   # smallest size that runs two api pods plus postgres comfortably
: "${NODE_COUNT:=2}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL to the address Lets Encrypt notifies about expiry}"
: "${SECRETS_FILE:=k8s/base/secrets.yaml}"   # git-ignored copy of secrets.example.yaml with real values
: "${DATADOG_API_KEY:=}"                      # optional: empty skips the Datadog agent

NGF_VERSION="v2.8.0"            # https://docs.nginx.com/nginx-gateway-fabric/install/helm/
CERT_MANAGER_VERSION="v1.19.2"  # https://cert-manager.io/docs/installation/helm/

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
  --version "${NGF_VERSION#v}" --create-namespace -n nginx-gateway

# 3. cert-manager, with Gateway API support so the HTTP-01 challenge can be
#    answered through an HTTPRoute instead of an Ingress
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --version "$CERT_MANAGER_VERSION" --create-namespace -n cert-manager \
  --set crds.enabled=true \
  --set config.apiVersion=controller.config.cert-manager.io/v1alpha1 \
  --set config.kind=ControllerConfiguration \
  --set config.enableGatewayAPI=true
kubectl -n cert-manager rollout status deployment/cert-manager --timeout=120s

# 4. Namespace, Secret, issuer, then the application
kubectl apply -f k8s/base/namespace.yaml
kubectl apply -f "$SECRETS_FILE"
sed "s/LETSENCRYPT_EMAIL/$LETSENCRYPT_EMAIL/" k8s/doks/cluster-issuer.yaml | kubectl apply -f -
kubectl apply -k k8s/doks

# 4b. Datadog agent (#27), only when an API key is in the environment. The key
#     goes into a Secret; the chart reads it from there (SEC-1).
if [ -n "$DATADOG_API_KEY" ]; then
  helm repo add datadog https://helm.datadoghq.com >/dev/null 2>&1 || true
  helm repo update >/dev/null
  kubectl create namespace datadog --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n datadog create secret generic datadog-secret --from-literal api-key="$DATADOG_API_KEY" \
    --dry-run=client -o yaml | kubectl apply -f -
  helm upgrade --install datadog-agent datadog/datadog -n datadog -f k8s/doks/datadog-values.yaml
fi

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
echo "For CI rollouts, add the repository secret KUBECONFIG with: base64 -w0 ~/.kube/config"
