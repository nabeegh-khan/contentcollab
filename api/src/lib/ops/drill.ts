// The restart drill (D31): evict one pod so the audience watches Kubernetes replace it. The code, not the
// client, picks the pod; one drill a minute across API pods (Redis lock); the audit row is written first.
import { HttpError } from "../httpError.js";
import { containersFrom } from "./containers.js";

export type DrillTarget = "api" | "postgres";

const NAMESPACE = "contentcollab";
const LOCK_KEY = "ops:drill:lock";
const LOCK_SECONDS = 60;
const MS_PER_SECOND = 1000;
const POSTGRES_POD = "postgres-0";
const MIN_READY_API_PODS = 2;
const HTTP_CONFLICT = 409;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY = 429;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;
const FINISH_WAIT_MS = 2000;

export type Outcome = "evicted" | "refused" | "failed";

export interface DrillDeps {
  /** The name of the pod answering this request. */
  hostname: string;
  now: () => number;
  redis: {
    isReady: boolean;
    set: (key: string, value: string, options: { NX: true; EX: number }) => Promise<string | null>;
    ttl: (key: string) => Promise<number>;
    del: (key: string) => Promise<number>;
  };
  listPods: () => Promise<unknown>;
  /** POSTs an Eviction to the pod's eviction subresource; rejects with a `status` on a non-2xx. */
  evict: (path: string, body: unknown) => Promise<void>;
  recordDrill: (row: { actorUserId: string; target: DrillTarget; pod: string }) => Promise<string>;
  finishDrill: (id: string, outcome: Outcome) => Promise<void>;
  log: (msg: string, fields: Record<string, unknown>) => void;
  /** How long to wait for the outcome write (default 2 s): the database may be the pod being stopped. */
  finishWaitMs?: number;
}

/** A refusal that carries the seconds until the next drill may start. */
export class DrillRateLimited extends HttpError {
  constructor(public readonly retryAfterSeconds: number) {
    super(HTTP_TOO_MANY, "RATE_LIMITED", "One drill a minute: try again shortly");
    this.name = "DrillRateLimited";
  }
}

function eviction(pod: string) {
  return {
    apiVersion: "policy/v1",
    kind: "Eviction",
    metadata: { name: pod, namespace: NAMESPACE },
  };
}

// The oldest ready API pod that is not the one answering this request; at least two must be ready
async function chooseApiPod(deps: DrillDeps): Promise<string> {
  // Not knowing which pod answers could mean stopping it mid-response: refuse instead
  if (deps.hostname === "") {
    throw new HttpError(
      HTTP_UNAVAILABLE,
      "UNAVAILABLE",
      "This pod does not know its own name, so a drill is not safe",
    );
  }
  const ready = containersFrom(await deps.listPods(), deps.hostname, deps.now()).filter(
    (c) => c.component === "api" && c.ready && c.status === "Running",
  );
  const candidates = ready
    .filter((c) => !c.servingThisRequest)
    .sort((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? ""));
  const [chosen] = candidates;
  if (ready.length < MIN_READY_API_PODS || !chosen) {
    throw new HttpError(
      HTTP_CONFLICT,
      "CONFLICT",
      "A drill needs two ready API pods, so one can stop while the other serves",
    );
  }
  return chosen.pod;
}

const statusOf = (error: unknown): number | null => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
};

export async function runDrill(deps: DrillDeps, target: DrillTarget, actorUserId: string) {
  if (!deps.redis.isReady) {
    throw new HttpError(HTTP_UNAVAILABLE, "UNAVAILABLE", "Drills are paused: Redis is not ready");
  }
  const locked = await deps.redis.set(LOCK_KEY, actorUserId, { NX: true, EX: LOCK_SECONDS });
  if (locked === null) throw new DrillRateLimited(await deps.redis.ttl(LOCK_KEY));

  // Anything refused before the eviction is sent gives the lock back: nothing happened to rate-limit
  const unlockAnd = async (error: HttpError): Promise<never> => {
    await deps.redis.del(LOCK_KEY).catch(() => 0);
    throw error;
  };

  let pod: string;
  try {
    pod = target === "postgres" ? POSTGRES_POD : await chooseApiPod(deps);
  } catch (error) {
    if (error instanceof HttpError) return unlockAnd(error);
    return unlockAnd(new HttpError(HTTP_BAD_GATEWAY, "UPSTREAM", "Could not read the pods"));
  }

  let id: string;
  try {
    id = await deps.recordDrill({ actorUserId, target, pod });
  } catch {
    return unlockAnd(
      new HttpError(
        HTTP_UNAVAILABLE,
        "UNAVAILABLE",
        "The drill was not started: it could not be recorded",
      ),
    );
  }

  const finish = async (outcome: Outcome) => {
    // Best effort: while PostgreSQL is the target the database may already be stopping
    await Promise.race([
      deps.finishDrill(id, outcome).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, deps.finishWaitMs ?? FINISH_WAIT_MS)),
    ]);
    deps.log("ops drill", { actor_user_id: actorUserId, target, pod, outcome });
  };

  try {
    await deps.evict(`/api/v1/namespaces/${NAMESPACE}/pods/${pod}/eviction`, eviction(pod));
  } catch (error) {
    const status = statusOf(error);
    if (status === HTTP_TOO_MANY) {
      await finish("refused");
      throw new HttpError(
        HTTP_CONFLICT,
        "CONFLICT",
        "Kubernetes refused: the disruption budget allows no stop right now",
      );
    }
    await finish("failed");
    if (status === HTTP_FORBIDDEN) {
      throw new HttpError(HTTP_FORBIDDEN, "FORBIDDEN", "Drills are switched off in this cluster");
    }
    throw new HttpError(HTTP_BAD_GATEWAY, "UPSTREAM", "Kubernetes did not accept the drill");
  }
  await finish("evicted");
  return {
    target,
    pod,
    startedAt: new Date(deps.now()).toISOString(),
    nextAllowedAt: new Date(deps.now() + LOCK_SECONDS * MS_PER_SECOND).toISOString(),
  };
}
