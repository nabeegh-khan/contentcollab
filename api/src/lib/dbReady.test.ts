import { describe, expect, it } from "@jest/globals";
import { createServer, type Socket } from "node:net";
import { Pool } from "pg";
import { requireDatabase } from "./dbReady.js";

// The first two cases talk to the test database that jest.env.js points at
// (the CI service container, or the one compose.test.yaml publishes locally).
const target = {
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
};

// A port that was free a moment ago: nothing answers there.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

describe("requireDatabase", () => {
  it("resolves when the test credentials are accepted", async () => {
    const pool = new Pool({
      ...target,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    try {
      await expect(requireDatabase(pool, 2000)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it("names host, port, user and the TEST_DB_PORT remedy when the server refuses the credentials", async () => {
    const pool = new Pool({ ...target, user: "nobody", password: "wrong" });
    try {
      await expect(requireDatabase(pool, 2000)).rejects.toThrow(
        new RegExp(
          `^PostgreSQL at ${target.host}:${target.port} refused user nobody .*TEST_DB_PORT=55432`,
        ),
      );
    } finally {
      await pool.end();
    }
  });

  it("gives up within the timeout when a server accepts the connection and never answers", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const pool = new Pool({
      host: "127.0.0.1",
      port,
      user: "test",
      password: "test",
      database: "x",
    });
    try {
      await expect(requireDatabase(pool, 500)).rejects.toThrow(
        new RegExp(
          `^PostgreSQL unreachable at 127.0.0.1:${port} .*Start the services first: docker compose`,
        ),
      );
      // Nothing may be left pending in the pool: this must return at once.
      await pool.end();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the start-the-services message when nothing listens on the port", async () => {
    const port = await freePort();
    const pool = new Pool({
      host: "127.0.0.1",
      port,
      user: "test",
      password: "test",
      database: "x",
    });
    try {
      await expect(requireDatabase(pool, 2000)).rejects.toThrow(
        new RegExp(
          `^PostgreSQL unreachable at 127.0.0.1:${port} .*Start the services first: docker compose`,
        ),
      );
    } finally {
      await pool.end();
    }
  });
});
