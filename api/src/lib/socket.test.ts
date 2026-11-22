import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { io as createClient, type Socket } from "socket.io-client";
import { pool } from "./db.js";
import { connectRedis, redis } from "./redis.js";
import { requireServices } from "./reachable.js";
import { requireDatabase } from "./dbReady.js";
import { createSocketServer } from "./socket.js";
import { emitToVersion } from "./realtime.js";

const testSecret = "socket-test-secret-that-is-not-used-outside-tests";
const previousSecret = process.env.JWT_SECRET;

const createdUserIds: string[] = [];
const createdDocumentIds: string[] = [];
const clients: Socket[] = [];

let httpServer: HttpServer;
let socketServer: ReturnType<typeof createSocketServer>;
let socketUrl: string;
let versionId: string;
let authorizedUserId: string;
let unauthorizedUserId: string;

function createToken(userId: string): string {
  return jwt.sign({}, testSecret, {
    subject: userId,
    expiresIn: "24h",
  });
}

async function createUser(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`socket-${crypto.randomUUID()}@example.com`, "test-hash", "Socket Test User"],
  );

  const id = result.rows[0]!.id;
  createdUserIds.push(id);
  return id;
}

function connectClient(token: string): Socket {
  const client = createClient(socketUrl, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
  });

  clients.push(client);
  return client;
}

async function waitForConnection(client: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = testSecret;

  await requireServices(
    [
      {
        name: "PostgreSQL",
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 5432),
      },
      {
        name: "Redis",
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    ],
    1000,
  );

  await requireDatabase(pool, 1000);
  await connectRedis();

  authorizedUserId = await createUser();
  unauthorizedUserId = await createUser();

  const document = await pool.query<{ id: string }>(
    `INSERT INTO documents (title, owner_id)
     VALUES ($1, $2)
     RETURNING id`,
    ["Socket.IO integration test", authorizedUserId],
  );
  const documentId = document.rows[0]!.id;
  createdDocumentIds.push(documentId);

  const version = await pool.query<{ id: string }>(
    `INSERT INTO document_versions
       (document_id, number, filename, content_type, size, checksum, object_key, uploaded_by)
     VALUES ($1, 1, $2, $3, 0, $4, $5, $6)
     RETURNING id`,
    [
      documentId,
      "socket-test.txt",
      "text/plain",
      crypto.randomUUID(),
      `socket-tests/${crypto.randomUUID()}`,
      authorizedUserId,
    ],
  );
  versionId = version.rows[0]!.id;

  await pool.query(
    `INSERT INTO shares (document_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [documentId, authorizedUserId, "editor"],
  );

  httpServer = createServer();
  socketServer = createSocketServer(httpServer);
  await socketServer.connectRedisClients();

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const address = httpServer.address() as AddressInfo;
  socketUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const client of clients) {
    client.disconnect();
  }

  if (socketServer) await socketServer.close();

  if (createdDocumentIds.length > 0) {
    await pool.query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [createdDocumentIds]);
  }

  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]);
  }

  if (redis.isOpen) await redis.quit();
  await pool.end();

  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

describe("Socket.IO authentication and room authorization", () => {
  it("rejects a connection with an invalid JWT", async () => {
    const client = connectClient("invalid-token");

    await expect(
      new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("connect_error", reject);
      }),
    ).rejects.toThrow();

    expect(client.connected).toBe(false);
  });

  it("refuses a version room join when the user has no share", async () => {
    const client = connectClient(createToken(unauthorizedUserId));
    await waitForConnection(client);

    const response = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      client.emit("join", { versionId }, resolve);
    });

    expect(response).toEqual({ ok: false, code: "NOT_FOUND" });
  });
  it("rejects a join with a malformed version ID", async () => {
    const client = connectClient(createToken(authorizedUserId));
    await waitForConnection(client);

    const response = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      client.emit("join", { versionId: "not-a-valid-uuid" }, resolve);
    });

    expect(response).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses a version room join when the user's share has expired", async () => {
    await pool.query(
      `INSERT INTO shares (document_id, user_id, role, expires_at)
      SELECT document_id, $1, $2, NOW() - INTERVAL '1 hour'
      FROM document_versions
      WHERE id = $3`,
      [unauthorizedUserId, "editor", versionId],
    );

    try {
      const client = connectClient(createToken(unauthorizedUserId));
      await waitForConnection(client);

      const response = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
        client.emit("join", { versionId }, resolve);
      });

      expect(response).toEqual({ ok: false, code: "NOT_FOUND" });
    } finally {
      await pool.query(
        `DELETE FROM shares WHERE user_id = $1 AND document_id = (
          SELECT document_id FROM document_versions WHERE id = $2
        )`,
        [unauthorizedUserId, versionId],
      );
    }
  });
  it("returns INTERNAL_ERROR when the database query fails during a join", async () => {
    const client = connectClient(createToken(authorizedUserId));
    await waitForConnection(client);

    const querySpy = jest.spyOn(pool, "query").mockImplementationOnce(async () => {
      throw new Error("Simulated database failure");
    });

    try {
      const response = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
        client.emit("join", { versionId }, resolve);
      });

      expect(response).toEqual({ ok: false, code: "INTERNAL_ERROR" });
    } finally {
      querySpy.mockRestore();
    }
  });

  it("delivers comment:created to a client authorized for the version", async () => {
    const client = connectClient(createToken(authorizedUserId));
    await waitForConnection(client);

    const joinResponse = await new Promise<{ ok: boolean }>((resolve) => {
      client.emit("join", { versionId }, resolve);
    });

    expect(joinResponse).toEqual({ ok: true });

    const payload = {
      id: crypto.randomUUID(),
      versionId,
      body: "Socket.IO integration test comment",
    };

    const received = new Promise<typeof payload>((resolve) => {
      client.once("comment:created", resolve);
    });

    emitToVersion(versionId, "comment:created", payload);

    await expect(received).resolves.toEqual(payload);
  });
  it("delivers events across two Socket.IO server instances using the Redis adapter", async () => {
    const secondHttpServer = createServer();
    const secondSocketServer = createSocketServer(secondHttpServer);

    try {
      await secondSocketServer.connectRedisClients();

      await new Promise<void>((resolve) => {
        secondHttpServer.listen(0, "127.0.0.1", resolve);
      });

      const client = connectClient(createToken(authorizedUserId));
      await waitForConnection(client);

      const joinResponse = await new Promise<{ ok: boolean }>((resolve) => {
        client.emit("join", { versionId }, resolve);
      });

      expect(joinResponse).toEqual({ ok: true });

      const payload = {
        id: crypto.randomUUID(),
        versionId,
        body: "Event emitted by the second server",
      };

      const received = new Promise<typeof payload>((resolve) => {
        client.once("comment:created", resolve);
      });

      secondSocketServer.io.to(`version:${versionId}`).emit("comment:created", payload);

      await expect(received).resolves.toEqual(payload);
    } finally {
      await secondSocketServer.close();
    }
  });
});
