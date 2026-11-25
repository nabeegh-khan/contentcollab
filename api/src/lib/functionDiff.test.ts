// The API's call to the compare function and its fallback (#180, ARCHITECTURE D39). The network, the
// clock and Redis are replaced by small stand-ins, so nothing here leaves the process.
import { describe, expect, it, jest } from "@jest/globals";
import { lineDiff } from "./diff.js";
import {
  diffWith,
  functionConfigFromEnv,
  MAX_INLINE_BYTES,
  redisInvocationStore,
  type FunctionConfig,
  type Invocation,
  type InvocationStore,
} from "./functionDiff.js";

const CONFIG: FunctionConfig = {
  url: "https://faas.example/api/v1/web/ns/compare/diff",
  token: "t-123",
};
const HTTP_OK = 200;
const HTTP_BAD_GATEWAY = 502;
const HTTP_TOO_MANY = 429;
const SHORT_TIMEOUT = 25;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const SIX_BYTES = 6;
const COMPUTE_MS = 3.5;
const EURO_COUNT = 150_000;

const goodBody = (before: string, after: string) => ({
  ...lineDiff(before, after),
  computeMs: COMPUTE_MS,
});
const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function memoryStore(): InvocationStore & { items: Invocation[] } {
  const items: Invocation[] = [];
  return {
    items,
    push: async (i) => {
      items.unshift(i);
    },
    recent: async () => items,
  };
}

const clock = () => {
  let t = 0;
  return () => (t += TWO);
};

function setup(fetchFn: typeof fetch, config: FunctionConfig | null = CONFIG) {
  const store = memoryStore();
  const local = jest.fn(lineDiff);
  const diff = diffWith({
    config,
    fetchFn,
    local,
    store,
    now: clock(),
    timeoutMs: SHORT_TIMEOUT,
    at: () => "2026-11-25T15:00:00.000Z",
  });
  return { diff, store, local };
}

describe("functionConfigFromEnv", () => {
  it("needs both the address and the shared value", () => {
    expect(functionConfigFromEnv({})).toBeNull();
    expect(functionConfigFromEnv({ FUNCTION_DIFF_URL: CONFIG.url })).toBeNull();
    expect(functionConfigFromEnv({ FUNCTION_AUTH_TOKEN: "x" })).toBeNull();
    expect(functionConfigFromEnv({ FUNCTION_DIFF_URL: "", FUNCTION_AUTH_TOKEN: "x" })).toBeNull();
  });
  it("accepts only an https address", () => {
    expect(
      functionConfigFromEnv({ FUNCTION_DIFF_URL: "http://x/y", FUNCTION_AUTH_TOKEN: "x" }),
    ).toBeNull();
    expect(
      functionConfigFromEnv({ FUNCTION_DIFF_URL: "not a url", FUNCTION_AUTH_TOKEN: "x" }),
    ).toBeNull();
    expect(
      functionConfigFromEnv({ FUNCTION_DIFF_URL: CONFIG.url, FUNCTION_AUTH_TOKEN: "t-123" }),
    ).toEqual(CONFIG);
  });
});

describe("diffWith", () => {
  it("uses the function's answer and records it", async () => {
    const fetchFn = jest.fn(async () => jsonResponse(HTTP_OK, goodBody("a\nb", "a\nc")));
    const { diff, store, local } = setup(fetchFn as unknown as typeof fetch);
    const result = await diff("a\nb", "a\nc");
    expect(result.added).toBe(ONE);
    expect(result.lines).toHaveLength(THREE);
    expect(local).not.toHaveBeenCalled();
    expect(store.items).toEqual([
      {
        at: "2026-11-25T15:00:00.000Z",
        outcome: "function",
        ms: TWO,
        computeMs: COMPUTE_MS,
        inputBytes: SIX_BYTES,
        reason: null,
      },
    ]);
  });

  it("sends both texts, the auth header and a bounded wait, and never logs the texts", async () => {
    const fetchFn = jest.fn(async () => jsonResponse(HTTP_OK, goodBody("a", "b")));
    const { diff } = setup(fetchFn as unknown as typeof fetch);
    await diff("a", "b");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CONFIG.url);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Require-Whisk-Auth"]).toBe("t-123");
    expect(JSON.parse(init.body as string)).toEqual({ before: "a", after: "b" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("computes the diff itself when no function is configured, and records nothing", async () => {
    const fetchFn = jest.fn();
    const { diff, store, local } = setup(fetchFn as unknown as typeof fetch, null);
    expect((await diff("a", "b")).added).toBe(ONE);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledTimes(ONE);
    expect(store.items).toEqual([]);
  });

  it("falls back, with the reason, on a bad status", async () => {
    const fetchFn = jest.fn(async () => jsonResponse(HTTP_BAD_GATEWAY, { error: "x" }));
    const { diff, store, local } = setup(fetchFn as unknown as typeof fetch);
    expect((await diff("a", "b")).removed).toBe(ONE);
    expect(local).toHaveBeenCalledTimes(ONE);
    expect(store.items[0]).toMatchObject({
      outcome: "fallback",
      reason: "status 502",
      computeMs: null,
    });
  });

  it("falls back when the namespace is at its concurrency limit", async () => {
    const fetchFn = jest.fn(async () => jsonResponse(HTTP_TOO_MANY, {}));
    const { diff, store } = setup(fetchFn as unknown as typeof fetch);
    await diff("a", "b");
    expect(store.items[0]?.reason).toBe("status 429");
  });

  it.each([[{}], [{ lines: "x", added: 0, removed: 0 }], [{ lines: [], added: "0", removed: 0 }]])(
    "falls back on a body that is not a diff: %j",
    async (body) => {
      const fetchFn = jest.fn(async () => jsonResponse(HTTP_OK, body));
      const { diff, store } = setup(fetchFn as unknown as typeof fetch);
      await diff("a", "b");
      expect(store.items[0]).toMatchObject({ outcome: "fallback", reason: "bad reply" });
    },
  );

  it("falls back on a body that is not JSON", async () => {
    const fetchFn = jest.fn(async () => new Response("<html>", { status: HTTP_OK }));
    const { diff, store } = setup(fetchFn as unknown as typeof fetch);
    await diff("a", "b");
    expect(store.items[0]?.reason).toBe("bad reply");
  });

  it("falls back on a network error without putting its text in the record", async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND faas.example");
    });
    const { diff, store } = setup(fetchFn as unknown as typeof fetch);
    await diff("a", "b");
    expect(store.items[0]).toMatchObject({ outcome: "fallback", reason: "network error" });
  });

  it("falls back when the function does not answer in time", async () => {
    const fetchFn = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("t", "TimeoutError")),
          );
        }),
    );
    const { diff, store } = setup(fetchFn as unknown as typeof fetch);
    expect((await diff("a", "b")).added).toBe(ONE);
    expect(store.items[0]).toMatchObject({ outcome: "fallback", reason: "timeout" });
  });

  it("does not send an input over the inline limit", async () => {
    const fetchFn = jest.fn();
    const { diff, store, local } = setup(fetchFn as unknown as typeof fetch);
    await diff("x\n".repeat(MAX_INLINE_BYTES), "y");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledTimes(ONE);
    expect(store.items[0]).toMatchObject({
      outcome: "fallback",
      reason: "input over the inline limit",
    });
  });

  it("counts bytes, not characters", async () => {
    const fetchFn = jest.fn();
    const { diff, store } = setup(fetchFn as unknown as typeof fetch);
    // 150,000 three-byte characters a side: 300,000 characters, 900,000 bytes
    await diff("€".repeat(EURO_COUNT), "€".repeat(EURO_COUNT) + "x");
    expect(store.items[0]?.reason).toBe("input over the inline limit");
  });

  it("still answers when the record cannot be saved", async () => {
    const fetchFn = jest.fn(async () => jsonResponse(HTTP_OK, goodBody("a", "b")));
    const store: InvocationStore = {
      push: async () => {
        throw new Error("redis down");
      },
      recent: async () => [],
    };
    const diff = diffWith({
      config: CONFIG,
      fetchFn: fetchFn as unknown as typeof fetch,
      local: lineDiff,
      store,
      now: clock(),
    });
    expect((await diff("a", "b")).added).toBe(ONE);
  });
});

describe("redisInvocationStore", () => {
  it("pushes the newest first, keeps 20 and reads them back", async () => {
    const calls: string[] = [];
    const client = {
      lPush: jest.fn(async (key: string, value: string) => {
        calls.push(`lPush ${key} ${value.length > 0}`);
        return ONE;
      }),
      lTrim: jest.fn(async (key: string, start: number, stop: number) => {
        calls.push(`lTrim ${key} ${start} ${stop}`);
        return "OK";
      }),
      lRange: jest.fn(async () => [
        JSON.stringify({
          at: "t",
          outcome: "function",
          ms: 1,
          computeMs: 1,
          inputBytes: 1,
          reason: null,
        }),
        "not json",
      ]),
    };
    const store = redisInvocationStore(client);
    await store.push({
      at: "t",
      outcome: "function",
      ms: 1,
      computeMs: 1,
      inputBytes: 1,
      reason: null,
    });
    expect(calls).toEqual(["lPush ops:fn:invocations true", "lTrim ops:fn:invocations 0 19"]);
    const recent = await store.recent();
    expect(recent).toHaveLength(ONE);
    expect(recent[0]?.outcome).toBe("function");
  });
});
