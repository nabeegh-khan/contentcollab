import type { Server as HttpServer } from "node:http";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { pool } from "./db.js";
import { connectRedis, logStateChanges, redis } from "./redis.js";
import { jwtSecret } from "../middleware/requireAuth.js";
import { setRealtimeServer } from "./realtime.js";
import { errorFields, log } from "./log.js";
import { registerSessionCounter, replicaName } from "./ops/sessions.js";

interface JoinResponse {
  ok: boolean;
  code?: "NOT_FOUND" | "INTERNAL_ERROR";
}

// How long a request to the other replicas (the session count, D38) waits for answers; the adapter default is 5 s
const REPLICA_REQUEST_TIMEOUT_MS = 2000;

export interface SocketServerOptions {
  /** This replica's name in the session count; the pod name unless a test names it. */
  replica?: string;
  requestsTimeoutMs?: number;
}

export function createSocketServer(httpServer: HttpServer, options: SocketServerOptions = {}) {
  const subClient = redis.duplicate();
  logStateChanges(subClient);

  const io = new Server(httpServer, {
    path: "/socket.io",
    transports: ["websocket"],
  });

  io.adapter(
    createAdapter(redis, subClient, {
      requestsTimeout: options.requestsTimeoutMs ?? REPLICA_REQUEST_TIMEOUT_MS,
    }),
  );
  setRealtimeServer(io);
  registerSessionCounter(io, options.replica ?? replicaName());

  // Authenticate every Socket.IO connection using the JWT handshake token.
  io.use((socket, next) => {
    const token: unknown = socket.handshake.auth?.token;

    if (typeof token !== "string" || !token) {
      next(new Error("UNAUTHORIZED"));
      return;
    }

    try {
      const payload = jwt.verify(token, jwtSecret(), {
        algorithms: ["HS256"],
      }) as JwtPayload;

      if (typeof payload.sub !== "string") {
        next(new Error("UNAUTHORIZED"));
        return;
      }

      if (!redis.isReady || !subClient.isReady) {
        next(new Error("REDIS_UNAVAILABLE"));
        return;
      }

      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;

    // Private room for mention notifications.
    void socket.join(`user:${userId}`);

    socket.on("join", async (payload: unknown, acknowledge?: (response: JoinResponse) => void) => {
      if (typeof acknowledge !== "function") return;

      const versionId =
        typeof payload === "object" && payload !== null && "versionId" in payload
          ? payload.versionId
          : undefined;

      if (
        typeof versionId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)
      ) {
        acknowledge({ ok: false, code: "NOT_FOUND" });
        return;
      }

      try {
        const result = await pool.query<{ document_id: string }>(
          `SELECT dv.document_id
                FROM document_versions dv
                JOIN shares s ON s.document_id = dv.document_id
                WHERE dv.id = $1
                    AND s.user_id = $2
                    AND (s.expires_at IS NULL OR s.expires_at > NOW())
                LIMIT 1`,
          [versionId, userId],
        );

        const documentId = result.rows[0]?.document_id;

        if (!documentId) {
          acknowledge({ ok: false, code: "NOT_FOUND" });
          return;
        }

        await socket.join(`version:${versionId}`);
        await socket.join(`document:${documentId}`);
        acknowledge({ ok: true });
      } catch (err) {
        log("error", "socket: join failed", {
          component: "socket",
          user_id: userId,
          error: errorFields(err),
        });
        acknowledge({ ok: false, code: "INTERNAL_ERROR" });
      }
    });
  });

  return {
    io,
    subClient,

    async connectRedisClients(): Promise<void> {
      await connectRedis();

      if (!subClient.isOpen) {
        await subClient.connect();
      }
    },

    async close(): Promise<void> {
      await new Promise<void>((resolve) => io.close(() => resolve()));

      if (subClient.isOpen) {
        await subClient.quit();
      }
    },
  };
}
