// Edge cases of the function call found by the verifier pass (#180, D39): a stalled list, a timeout while
// reading the reply, what is logged, redirects, and that the function's diff equals the API's.
import { describe, expect, it, jest } from "@jest/globals";
import { createRequire } from "node:module";
import { lineDiff } from "./diff.js";
import { compareDiff } from "./compareDiff.js";
import { diffWith, type FunctionConfig, type InvocationStore } from "./functionDiff.js";

const CONFIG: FunctionConfig = { url: "https://faas.example/x", token: "tok-SECRET-9" };
const HTTP_OK = 200;
const WAIT_MS = 500;
const SHORT = 25;
const ONE = 1;

const okBody = () => ({ ...lineDiff("a", "b"), computeMs: ONE });
const okResponse = () => new Response(JSON.stringify(okBody()), { status: HTTP_OK });
const memory = (): InvocationStore & { items: unknown[] } => {
  const items: unknown[] = [];
  return {
    items,
    push: async (i) => {
      items.unshift(i);
    },
    recent: async () => [],
  };
};

describe("the call to the function", () => {
  it("answers even when the list never accepts the record (a Redis outage)", async () => {
    const hung: InvocationStore = {
      push: () => new Promise<void>(() => {}),
      recent: async () => [],
    };
    const diff = diffWith({
      config: CONFIG,
      fetchFn: (async () => okResponse()) as unknown as typeof fetch,
      local: lineDiff,
      store: hung,
    });
    const result = await Promise.race([
      diff("a", "b"),
      new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), WAIT_MS)),
    ]);
    expect(result).not.toBe("stalled");
  });

  it("reports a timeout while the reply is being read as a timeout, not a bad reply", async () => {
    const slowBody = {
      status: HTTP_OK,
      json: async () => {
        throw new DOMException("t", "TimeoutError");
      },
    };
    const store = memory();
    const diff = diffWith({
      config: CONFIG,
      fetchFn: (async () => slowBody) as unknown as typeof fetch,
      local: lineDiff,
      store,
      timeoutMs: SHORT,
    });
    await diff("a", "b");
    expect(store.items[0]).toMatchObject({ outcome: "fallback", reason: "timeout" });
  });

  it("does not follow redirects, which would carry the auth header along", async () => {
    const fetchFn = jest.fn(async () => okResponse());
    const diff = diffWith({
      config: CONFIG,
      fetchFn: fetchFn as unknown as typeof fetch,
      local: lineDiff,
      store: memory(),
    });
    await diff("a", "b");
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[ONE];
    expect(init.redirect).toBe("error");
  });

  it("logs neither the texts nor the shared value, on success or on a fallback", async () => {
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const failing = (async () => {
        throw new Error("boom tok-SECRET-9 private-words");
      }) as unknown as typeof fetch;
      await diffWith({ config: CONFIG, fetchFn: failing, local: lineDiff, store: memory() })(
        "private-words one",
        "private-words two",
      );
      const hungStore: InvocationStore = {
        push: async () => {
          throw new Error("tok-SECRET-9 private-words");
        },
        recent: async () => [],
      };
      await diffWith({ config: CONFIG, fetchFn: failing, local: lineDiff, store: hungStore })(
        "a",
        "b",
      );
    } finally {
      spy.mockRestore();
    }
    const all = written.join("");
    expect(all).toContain("falling back");
    expect(all).not.toContain("private-words");
    expect(all).not.toContain("tok-SECRET-9");
  });
});

describe("compareDiff, the factory the compare route uses", () => {
  it("calls the function when both variables are set", async () => {
    const fetchFn = jest.fn(async () => okResponse());
    const diff = compareDiff(
      { FUNCTION_DIFF_URL: CONFIG.url, FUNCTION_AUTH_TOKEN: "x" },
      memory(),
      fetchFn as unknown as typeof fetch,
    );
    await diff("a", "b");
    expect(fetchFn).toHaveBeenCalledTimes(ONE);
  });

  it("computes locally and calls nothing when they are not", async () => {
    const fetchFn = jest.fn();
    const diff = compareDiff({}, memory(), fetchFn as unknown as typeof fetch);
    expect((await diff("a", "b")).added).toBe(ONE);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("the function's diff equals the API's", () => {
  const require = createRequire(import.meta.url);
  const fn = require("../../../functions/packages/compare/diff/diff.js") as {
    lineDiff: typeof lineDiff;
  };
  const cases: [string, string][] = [
    ["", ""],
    ["a\nb\nc\n", "a\nB\nc\n"],
    ["a\r\nb", "a\nb\n"],
    ["x\ny\nz", ""],
    ["", "x\ny"],
    ["one\ntwo\nthree\nfour\n", "zero\none\nthree\nfive\n"],
    ["same\nsame\nsame", "same\nsame"],
    ["é€ \n\n\nlast", "é€ \nlast\n\n"],
  ];
  it.each(cases)("%j against %j", (before, after) => {
    expect(fn.lineDiff(before, after)).toEqual(lineDiff(before, after));
  });
});
