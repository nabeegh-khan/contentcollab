import type { Server } from "socket.io";

// Open WebSocket sessions over every API replica (ARCHITECTURE D38). Each replica answers a server-side
// event over the Socket.IO Redis adapter with its own name and the size of its own socket list, and the
// caller adds its own. Only counts and replica names travel: no socket, handshake, token or user id.

export const SESSIONS_EVENT = "sessions:count";

export interface ReplicaSessions {
  replica: string;
  sessions: number;
}

export interface SessionCounts {
  total: number;
  /** True when a replica did not answer in time or sent an answer that was dropped. */
  partial: boolean;
  replicas: ReplicaSessions[];
}

/** The pod name (Kubernetes sets HOSTNAME to it); "api" where there is no pod. */
export const replicaName = (env: Record<string, string | undefined> = process.env): string =>
  env.HOSTNAME || "api";

const localSessions = (io: Server): number => io.of("/").sockets.size;

/** Makes this replica answer a `sessions:count` request with its own count. */
export function registerSessionCounter(io: Server, replica: string): void {
  io.on(SESSIONS_EVENT, (acknowledge?: unknown) => {
    if (typeof acknowledge !== "function") return;
    acknowledge({ replica, sessions: localSessions(io) } satisfies ReplicaSessions);
  });
}

// One replica's answer, or null when it is not a name and a whole, non-negative number of sessions
function toReplicaSessions(answer: unknown): ReplicaSessions | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { replica, sessions } = answer as Record<string, unknown>;
  if (typeof replica !== "string" || replica === "") return null;
  if (typeof sessions !== "number" || !Number.isInteger(sessions) || sessions < 0) return null;
  return { replica, sessions };
}

// Longer than the adapter's own 2 s wait for answers (REPLICA_REQUEST_TIMEOUT_MS in socket.ts)
const GIVE_UP_MS = 3000;

// The other replicas' answers. When one does not answer in time the adapter rejects and hands over the
// answers it did get (`responses`), which are kept. The adapter swallows its own errors on this path (its
// first step, counting the subscribers, can fail while Redis is down and then nothing ever settles), so the
// wait has its own limit
async function askOthers(
  io: Server,
  giveUpMs: number,
): Promise<{ answers: unknown[]; failed: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<{ answers: unknown[]; failed: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ answers: [], failed: true }), giveUpMs);
  });
  const asked = Promise.resolve()
    .then(() => io.serverSideEmitWithAck(SESSIONS_EVENT))
    .then((answers) => ({ answers, failed: false }))
    .catch((error: unknown) => {
      const responses = (error as { responses?: unknown }).responses;
      return { answers: Array.isArray(responses) ? responses : [], failed: true };
    });
  try {
    return await Promise.race([asked, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

export async function countSessions(
  io: Server,
  replica: string,
  giveUpMs = GIVE_UP_MS,
): Promise<SessionCounts> {
  const { answers, failed } = await askOthers(io, giveUpMs);
  const valid = answers.flatMap((answer) => toReplicaSessions(answer) ?? []);
  const replicas = [{ replica, sessions: localSessions(io) }, ...valid].sort((a, b) =>
    a.replica.localeCompare(b.replica),
  );
  return {
    total: replicas.reduce((sum, row) => sum + row.sessions, 0),
    partial: failed || valid.length !== answers.length,
    replicas,
  };
}
