#!/usr/bin/env bash
# Installs metrics-server on the DOKS cluster so the API's HPA can read CPU (#69, ARCHITECTURE D5).
#
#   bash scripts/metrics-server.sh          # kubectl must point at the cluster; needs helm
#
# DOKS has no resource metrics API until metrics-server is installed
# (DigitalOcean HPA guide). Same chart and replica count as DigitalOcean's own
# Marketplace stack (digitalocean/marketplace-kubernetes, stacks/metrics-server),
# but pinned: chart 3.14.0 ships metrics-server 0.9.0 (Chart.yaml at tag
# metrics-server-helm-chart-3.14.0, checked 6 Nov 2026). Kubelet TLS stays
# verified; no --kubelet-insecure-tls.
set -euo pipefail

: "${CHART_VERSION:=3.14.0}"

command -v helm >/dev/null || { echo "helm is required" >&2; exit 1; }
kubectl cluster-info >/dev/null || { echo "kubectl is not pointed at a cluster" >&2; exit 1; }

helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server --force-update >/dev/null
helm upgrade --install metrics-server metrics-server/metrics-server \
  --version "$CHART_VERSION" \
  --namespace metrics-server --create-namespace \
  --set replicas=2 \
  --atomic --wait --timeout 5m

# The first scrape takes about a minute; give it three
for _ in $(seq 1 18); do
  kubectl top nodes >/dev/null 2>&1 && break
  sleep 10
done
kubectl top nodes

# Exits 1 until the HPA reports a CPU reading (another 15 to 30 s after top works)
for _ in $(seq 1 12); do
  node "$(dirname "$0")/hpa-ready.mjs" && exit 0
  sleep 10
done
exit 1
