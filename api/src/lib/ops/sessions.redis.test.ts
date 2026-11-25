import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { io as createClient, type Socket } from "socket.io-client";
import { connectRedis, redis } from "../redis.js";
import { requireServices } from "../reachable.js";
import { createSocketServer } from "../socket.js";
import { countSessions } from "./sessions.js";

// D38: two API replicas (two Socket.IO servers over one Redis adapter, as two pods are) count the sessions
// of both. Needs only Redis; no database, because no client joins a room.
const SECRET = "sessions-test-secret-that-is-not-used-outside-tests";
const previousSecret = process.env.JWT_SECRET;
const DEFAULT_REDIS_PORT = 6379;
const REACH_MS = 1000;
const ASK_TIMEOUT_MS = 1000;
const SETTLE_MS = 3000;
const POLL_MS = 25;
const A = "api-a";
const B = "api-b";
const ON_A = 3;
const ON_B = 2;
const ALL = ON_A + ON_B;

interface Replica {
  name: string;
  server: ReturnType<typeof createSocketServer>;
  url: string;
}

const clients: Socket[] = [];
let a: Replica;
let b: Replica;

async function startReplica(name: string): Promise<Replica> {
  const httpServer = createServer();
  const server = createSocketServer(httpServer, {
    replica: name,
    requestsTimeoutMs: ASK_TIMEOUT_MS,
  });
  await server.connectRedisClients();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return { name, server, url: `http://127.0.0.1:${port}` };
}

async function connect(replica: Replica): Promise<Socket> {
  const token = jwt.sign({}, SECRET, { subject: crypto.randomUUID(), expiresIn: "1h" });
  const client = createClient(replica.url, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
  return client;
}

// The server notices a closed socket a moment after the client does, so a drop is awaited, not assumed
async function until(
  read: () => Promise<boolean>,
  deadline = Date.now() + SETTLE_MS,
): Promise<void> {
  if (await read()) return;
  if (Date.now() > deadline) throw new Error("the count did not settle");
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  return until(read, deadline);
}

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  await requireServices(
    [
      {
        name: "Redis",
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? DEFAULT_REDIS_PORT),
      },
    ],
    REACH_MS,
  );
  await connectRedis();
  a = await startReplica(A);
  b = await startReplica(B);
});

afterAll(async () => {
  clients.forEach((client) => client.disconnect());
  await a?.server.close();
  await b?.server.close();
  if (redis.isOpen) await redis.quit();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

describe("two API replicas over one Redis adapter", () => {
  const from = (replica: Replica) => () => countSessions(replica.server.io, replica.name);

  it("start with no sessions and each replica is one row of the split", async () => {
    expect(await from(a)()).toEqual({
      total: 0,
      partial: false,
      replicas: [
        { replica: A, sessions: 0 },
        { replica: B, sessions: 0 },
      ],
    });
  });

  it("count three sessions on one replica and two on the other as five, asked of either", async () => {
    await Promise.all([a, a, a, b, b].map(connect));
    const expected = {
      total: ALL,
      partial: false,
      replicas: [
        { replica: A, sessions: ON_A },
        { replica: B, sessions: ON_B },
      ],
    };
    expect(await from(a)()).toEqual(expected);
    expect(await from(b)()).toEqual(expected);
  });

  it("drop the count when a client disconnects", async () => {
    const [first] = clients;
    first!.disconnect();
    await until(async () => (await from(b)()).total === ALL - 1);
    expect((await from(a)()).replicas).toEqual([
      { replica: A, sessions: ON_A - 1 },
      { replica: B, sessions: ON_B },
    ]);
  });

  it("leave only the replica that is still up when the other is gone, without waiting for it", async () => {
    await b.server.close();
    const started = Date.now();
    await until(async () => (await from(a)()).replicas.length === 1);
    expect(await from(a)()).toEqual({
      total: ON_A - 1,
      partial: false,
      replicas: [{ replica: A, sessions: ON_A - 1 }],
    });
    expect(Date.now() - started).toBeLessThan(ASK_TIMEOUT_MS);
  });
});
