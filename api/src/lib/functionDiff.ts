// The API's call to the compare function, and its fallback (#180, ARCHITECTURE D39). The line diff of two
// versions goes to a DigitalOcean Function when one is configured and the input is small enough; on any
// failure the API computes the same diff itself (D33), so the user never sees the function fail. Each
// call is recorded in a short Redis list for the Operations page. Texts and the shared value are never
// logged or recorded.
import type { LineDiff } from "./diff.js";
import { log } from "./log.js";

export interface FunctionConfig {
  url: string;
  token: string;
}

export type Outcome = "function" | "fallback";

export interface Invocation {
  at: string;
  outcome: Outcome;
  /** Milliseconds as the API saw them: the call, or the call plus the local diff on a fallback. */
  ms: number;
  /** The function's own compute time, from its reply; null on a fallback. */
  computeMs: number | null;
  inputBytes: number;
  reason: string | null;
}

export interface InvocationStore {
  push(invocation: Invocation): Promise<void>;
  recent(): Promise<Invocation[]>;
}

/** The input is sent only up to this many bytes: the platform's limit is 1 MB for input and for the reply. */
export const MAX_INLINE_BYTES = 400_000;
export const FUNCTION_TIMEOUT_MS = 2000;
export const KEEP_INVOCATIONS = 20;
export const INVOCATIONS_KEY = "ops:fn:invocations";
const AUTH_HEADER = "X-Require-Whisk-Auth";
const LAST_INDEX = KEEP_INVOCATIONS - 1;
const HTTP_OK = 200;

/** Both values must be set, and the address must be https: otherwise no function is called. */
export function functionConfigFromEnv(
  env: Record<string, string | undefined>,
): FunctionConfig | null {
  const url = env.FUNCTION_DIFF_URL;
  const token = env.FUNCTION_AUTH_TOKEN;
  if (!url || !token) return null;
  try {
    return new URL(url).protocol === "https:" ? { url, token } : null;
  } catch {
    return null;
  }
}

const isDiffReply = (body: unknown): body is LineDiff & { computeMs?: unknown } => {
  const b = body as Partial<LineDiff> | null;
  return (
    typeof b === "object" &&
    b !== null &&
    Array.isArray(b.lines) &&
    typeof b.added === "number" &&
    typeof b.removed === "number"
  );
};

class FunctionFailed extends Error {}

/** One call. Throws FunctionFailed with a fixed reason; nothing from the reply or the network goes in it. */
async function callFunction(
  config: FunctionConfig,
  fetchFn: typeof fetch,
  timeoutMs: number,
  before: string,
  after: string,
): Promise<{ diff: LineDiff; computeMs: number | null }> {
  let response: Response;
  try {
    response = await fetchFn(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [AUTH_HEADER]: config.token },
      body: JSON.stringify({ before, after }),
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect would carry the auth header to wherever it points
      redirect: "error",
    });
  } catch (error) {
    // A DOMException is not always an Error in every realm, so the name is read, not the class
    const timedOut = (error as { name?: unknown } | null)?.name === "TimeoutError";
    throw new FunctionFailed(timedOut ? "timeout" : "network error");
  }
  if (response.status !== HTTP_OK) throw new FunctionFailed(`status ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // The time limit also covers reading the reply, so a stalled body is a timeout, not a bad reply
    const timedOut = (error as { name?: unknown } | null)?.name === "TimeoutError";
    throw new FunctionFailed(timedOut ? "timeout" : "bad reply");
  }
  if (!isDiffReply(body)) throw new FunctionFailed("bad reply");
  const computeMs = typeof body.computeMs === "number" ? body.computeMs : null;
  return { diff: { lines: body.lines, added: body.added, removed: body.removed }, computeMs };
}

export interface DifferOptions {
  config: FunctionConfig | null;
  fetchFn?: typeof fetch;
  local: (before: string, after: string) => LineDiff;
  store: InvocationStore;
  /** Milliseconds on a monotonic clock. */
  now?: () => number;
  timeoutMs?: number;
  at?: () => string;
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** The diff function the compare route uses: the function when it can, the local one when it cannot. */
export function diffWith(options: DifferOptions) {
  const { config, local, store } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? FUNCTION_TIMEOUT_MS;
  const at = options.at ?? (() => new Date().toISOString());

  // Not awaited by the caller: a list that hangs (Redis down, commands queued) must not hold up an answer
  const record = (invocation: Invocation): void => {
    void save(invocation);
  };
  const save = async (invocation: Invocation): Promise<void> => {
    try {
      await store.push(invocation);
    } catch (error) {
      // A list that cannot be written must not fail a comparison
      log("warn", "functionDiff: the invocation was not recorded", {
        component: "functionDiff",
        error: error instanceof Error ? { kind: error.name } : "unknown",
      });
    }
  };

  return async (before: string, after: string): Promise<LineDiff> => {
    if (!config) return local(before, after);
    const inputBytes = byteLength(before) + byteLength(after);
    const started = now();
    const stamp = at();
    const fallBack = async (reason: string): Promise<LineDiff> => {
      log("warn", "functionDiff: falling back to the local diff", {
        component: "functionDiff",
        reason,
      });
      const diff = local(before, after);
      record({
        at: stamp,
        outcome: "fallback",
        ms: Math.round(now() - started),
        computeMs: null,
        inputBytes,
        reason,
      });
      return diff;
    };
    if (inputBytes > MAX_INLINE_BYTES) return fallBack("input over the inline limit");
    try {
      const { diff, computeMs } = await callFunction(config, fetchFn, timeoutMs, before, after);
      record({
        at: stamp,
        outcome: "function",
        ms: Math.round(now() - started),
        computeMs,
        inputBytes,
        reason: null,
      });
      return diff;
    } catch (error) {
      return fallBack(error instanceof FunctionFailed ? error.message : "network error");
    }
  };
}

/** The part of the Redis client the list uses, so tests can pass a stand-in. */
export interface ListClient {
  lPush(key: string, value: string): Promise<number>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
}

const parseInvocation = (raw: string): Invocation[] => {
  try {
    const value = JSON.parse(raw) as Invocation;
    return typeof value === "object" && value !== null && typeof value.outcome === "string"
      ? [value]
      : [];
  } catch {
    return [];
  }
};

/** The last 20 invocations, newest first, in one Redis list shared by every replica. */
export function redisInvocationStore(client: ListClient): InvocationStore {
  return {
    push: async (invocation) => {
      await client.lPush(INVOCATIONS_KEY, JSON.stringify(invocation));
      await client.lTrim(INVOCATIONS_KEY, 0, LAST_INDEX);
    },
    recent: async () =>
      (await client.lRange(INVOCATIONS_KEY, 0, LAST_INDEX)).flatMap(parseInvocation),
  };
}
