import { readFileSync } from "node:fs";
import { request } from "node:https";

// Ready API replicas for the status page (#30, ARCHITECTURE D23), read from the Kubernetes API as the
// pod's own ServiceAccount, which may only `get` deployments/api (k8s/base/api-rbac.yaml).

export const DEPLOYMENT_PATH = "/apis/apps/v1/namespaces/contentcollab/deployments/api";

/** GET a Kubernetes API path and return the parsed JSON body. */
export type KubeGet = (path: string) => Promise<unknown>;

export async function readyReplicas(get: KubeGet): Promise<{ api: number }> {
  const deployment = (await get(DEPLOYMENT_PATH)) as { status?: { readyReplicas?: number } } | null;
  if (!deployment || typeof deployment.status !== "object" || deployment.status === null) {
    throw new Error("deployment: the reply had no status");
  }
  // A Deployment with no ready pod leaves the field out
  return { api: deployment.status.readyReplicas ?? 0 };
}

// Where Kubernetes mounts the pod's ServiceAccount token and the cluster CA
const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const REQUEST_TIMEOUT_MS = 1000;

/**
 * A KubeGet for code running in a pod, or null outside a cluster (no KUBERNETES_SERVICE_HOST). The
 * token is read on every call, since Kubernetes rotates projected tokens; the cluster CA is passed
 * explicitly, so nothing depends on how a global fetch treats extra CAs.
 */
export function inClusterGet(env: Record<string, string | undefined>): KubeGet | null {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = Number(env.KUBERNETES_SERVICE_PORT);
  if (!host || !Number.isInteger(port)) return null;
  return (path) =>
    new Promise((resolve, reject) => {
      const token = readFileSync(`${SERVICE_ACCOUNT_DIR}/token`, "utf8").trim();
      const req = request(
        {
          host,
          port,
          path,
          method: "GET",
          ca: readFileSync(`${SERVICE_ACCOUNT_DIR}/ca.crt`),
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("kubernetes API: no answer")));
      req.on("error", reject);
      req.end();
    });
}
