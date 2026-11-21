import { readFileSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request, type RequestOptions } from "node:https";

// Ready API replicas for the status page (#30, ARCHITECTURE D23), read from the Kubernetes API as the
// pod's own ServiceAccount, which may only `get` deployments/api (k8s/base/api-rbac.yaml).

export const DEPLOYMENT_PATH = "/apis/apps/v1/namespaces/contentcollab/deployments/api";

/** GET a Kubernetes API path and return the parsed JSON body. */
/** `text: true` returns the body as a string (pod logs) instead of parsed JSON. */
export type KubeGet = (path: string, options?: KubeOptions) => Promise<unknown>;

/** `method: "POST"` with a `body` sends JSON (the eviction call of the restart drill, D31). */
export interface KubeOptions {
  text?: boolean;
  method?: "GET" | "POST";
  body?: unknown;
}

/** A non-2xx answer from the apiserver, with its HTTP status for the caller. */
export class KubeApiError extends Error {
  constructor(public readonly status: number) {
    super(`kubernetes API answered ${status}`);
    this.name = "KubeApiError";
  }
}

export async function readyReplicas(get: KubeGet): Promise<{ api: number }> {
  const reply = (await get(DEPLOYMENT_PATH)) as {
    kind?: unknown;
    status?: { readyReplicas?: number };
  } | null;
  // A denied or missing object comes back as kind Status, whose `status` is a string
  if (
    !reply ||
    reply.kind !== "Deployment" ||
    typeof reply.status !== "object" ||
    reply.status === null
  ) {
    throw new Error("deployment: the reply was not the Deployment");
  }
  // A Deployment with no ready pod leaves the field out
  return { api: reply.status.readyReplicas ?? 0 };
}

// Where Kubernetes mounts the pod's ServiceAccount token and the cluster CA
const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const REQUEST_TIMEOUT_MS = 1000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

/** The file and HTTPS calls inClusterGet makes, so tests can pass stand-ins. */
export interface HttpsDeps {
  readFile: (path: string, encoding?: "utf8") => string | Buffer;
  request: (options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;
}

const realDeps: HttpsDeps = {
  readFile: (path, encoding) => (encoding ? readFileSync(path, encoding) : readFileSync(path)),
  request: (options, onResponse) => request(options, onResponse),
};

/**
 * A KubeGet for code running in a pod, or null outside a cluster (no KUBERNETES_SERVICE_HOST). The
 * token is read on every call, since Kubernetes rotates projected tokens; the cluster CA is passed
 * explicitly, so nothing depends on how a global fetch treats extra CAs. A non-2xx reply, a reply that
 * breaks off, or a missing token rejects.
 */
export function inClusterGet(
  env: Record<string, string | undefined>,
  deps: HttpsDeps = realDeps,
): KubeGet | null {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = Number(env.KUBERNETES_SERVICE_PORT);
  if (!host || !Number.isInteger(port)) return null;
  return (path, options) =>
    new Promise((resolve, reject) => {
      const token = String(deps.readFile(`${SERVICE_ACCOUNT_DIR}/token`, "utf8")).trim();
      const req = deps.request(
        {
          host,
          port,
          path,
          method: options?.method ?? "GET",
          ca: deps.readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: options?.text ? "text/plain" : "application/json",
            ...(options?.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("error", reject);
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const code = res.statusCode ?? 0;
            if (code < HTTP_OK_MIN || code > HTTP_OK_MAX) {
              reject(new KubeApiError(code));
              return;
            }
            try {
              const body = Buffer.concat(chunks).toString("utf8");
              resolve(options?.text ? body : JSON.parse(body));
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("kubernetes API: no answer")));
      req.on("error", reject);
      req.end(options?.body === undefined ? undefined : JSON.stringify(options.body));
    });
}

/**
 * At most one call to `read` per `ttlMs`, so a public endpoint polled by anyone does not turn every
 * request into an apiserver call: callers share the read in flight, and its outcome, a value or a
 * failure (a denied or unreachable apiserver), answers everyone until the window ends.
 */
export function cachedFor<T>(ttlMs: number, read: () => Promise<T>, now: () => number = Date.now) {
  let kept: { at: number; result: Promise<T> } | undefined;
  return (): Promise<T> => {
    if (kept && now() - kept.at < ttlMs) return kept.result;
    const result = read();
    kept = { at: now(), result };
    return result;
  };
}
