# k8s

Kubernetes manifests, applied with `kubectl apply -k` (Kustomize) in two overlays: `minikube/` for laptops and `doks/` for the cluster. Owner: Nabeegh.

```
k8s/
  base/        Deployments (api, web, worker), StatefulSet (postgres), Deployment (redis), Services,
               Ingress, HorizontalPodAutoscaler, PersistentVolumeClaim, CronJob (backup), ConfigMap
  minikube/    overlay: NodePort or minikube tunnel, local image tags, smaller resources
  doks/        overlay: DigitalOcean block-storage class, Ingress with cert-manager, LoadBalancer
  secrets.example.yaml   the shape of the Secret objects; real values are never committed
```
