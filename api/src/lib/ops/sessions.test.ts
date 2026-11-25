import { describe, expect, it, jest } from "@jest/globals";
import type { Server } from "socket.io";
import { countSessions, registerSessionCounter, SESSIONS_EVENT } from "./sessions.js";

// D38: the count of open WebSocket sessions over all API replicas. The Socket.IO server is a stand-in here;
// the two-replica run over a real Redis is in sessions.redis.test.ts.
const HERE = 2;
const IN_B = 3;
const IN_C = 1;
const IN_E = 5;
const NOT_WHOLE = 1.5;
const BEHIND = 4;
const ALL_THREE = HERE + IN_B + IN_C;
const HERE_AND_B = HERE + BEHIND;
const HERE_AND_E = HERE + IN_E;
const ASKED_OF_B = 7;

function fakeServer(options: {
  local?: number;
  answers?: unknown[];
  fail?: { message: string; responses?: unknown[] };
}): Server {
  const { local = HERE, answers = [], fail } = options;
  return {
    of: () => ({ sockets: { size: local } }),
    serverSideEmitWithAck: async () => {
      if (fail) throw Object.assign(new Error(fail.message), { responses: fail.responses });
      return answers;
    },
  } as unknown as Server;
}

describe("countSessions", () => {
  it("adds this replica's sessions to the other replicas' answers and sorts the split by name", async () => {
    const io = fakeServer({
      answers: [
        { replica: "api-c", sessions: IN_C },
        { replica: "api-b", sessions: IN_B },
      ],
    });
    expect(await countSessions(io, "api-a")).toEqual({
      total: ALL_THREE,
      partial: false,
      replicas: [
        { replica: "api-a", sessions: HERE },
        { replica: "api-b", sessions: IN_B },
        { replica: "api-c", sessions: IN_C },
      ],
    });
  });

  it("with one replica (nobody else answers) is one row and not partial", async () => {
    const counts = await countSessions(fakeServer({ local: 0 }), "api-a");
    expect(counts).toEqual({
      total: 0,
      partial: false,
      replicas: [{ replica: "api-a", sessions: 0 }],
    });
  });

  it("keeps the answers received when a replica did not answer in time, and says partial", async () => {
    const io = fakeServer({
      fail: {
        message: "timeout reached: only 1 responses received out of 2",
        responses: [{ replica: "api-b", sessions: BEHIND }],
      },
    });
    const counts = await countSessions(io, "api-a");
    expect(counts.partial).toBe(true);
    expect(counts.total).toBe(HERE_AND_B);
    expect(counts.replicas.map((r) => r.replica)).toEqual(["api-a", "api-b"]);
  });

  it("is partial, with only this replica, when the failure carries no answers", async () => {
    const counts = await countSessions(fakeServer({ fail: { message: "redis down" } }), "api-a");
    expect(counts).toEqual({
      total: HERE,
      partial: true,
      replicas: [{ replica: "api-a", sessions: HERE }],
    });
  });

  it("drops an answer that is not a replica name and a whole number of sessions, and says partial", async () => {
    const io = fakeServer({
      answers: [
        null,
        "api-x",
        { replica: "api-b" },
        { replica: "api-c", sessions: -1 },
        { replica: "api-d", sessions: NOT_WHOLE },
        { replica: "", sessions: 1 },
        { replica: "api-e", sessions: IN_E },
      ],
    });
    const counts = await countSessions(io, "api-a");
    expect(counts.partial).toBe(true);
    expect(counts.replicas).toEqual([
      { replica: "api-a", sessions: HERE },
      { replica: "api-e", sessions: IN_E },
    ]);
    expect(counts.total).toBe(HERE_AND_E);
  });

  it("returns only counts and replica names, never anything else a replica sent", async () => {
    const io = fakeServer({
      answers: [{ replica: "api-b", sessions: 1, token: "eyJ.secret", userId: "u-1" }],
    });
    const text = JSON.stringify(await countSessions(io, "api-a"));
    ["secret", "u-1", "token", "userId"].forEach((word) => expect(text).not.toContain(word));
  });
});

describe("registerSessionCounter", () => {
  function registered(local: number) {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const io = {
      of: () => ({ sockets: { size: local } }),
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    } as unknown as Server;
    registerSessionCounter(io, "api-b");
    return handlers.get(SESSIONS_EVENT);
  }

  it("answers the request with this replica's name and its own socket count", () => {
    const ack = jest.fn();
    registered(ASKED_OF_B)?.(ack);
    expect(ack).toHaveBeenCalledWith({ replica: "api-b", sessions: ASKED_OF_B });
  });

  it("ignores a request that carries no acknowledgement", () => {
    expect(() => registered(ASKED_OF_B)?.()).not.toThrow();
    expect(() => registered(ASKED_OF_B)?.("not a function")).not.toThrow();
  });
});
