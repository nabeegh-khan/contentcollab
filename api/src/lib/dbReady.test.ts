import { describe, expect, it } from "@jest/globals";
import { Pool } from "pg";
import { requireDatabase } from "./dbReady.js";

// Both cases talk to the test database that jest.env.js points at (the CI
// service container, or the one compose.test.yaml publishes locally).
const target = {
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
};

describe("requireDatabase", () => {
  it("resolves when the test credentials are accepted", async () => {
    const pool = new Pool({
      ...target,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    try {
      await expect(requireDatabase(pool)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it("names host, port, user and the TEST_DB_PORT remedy when the server refuses the credentials", async () => {
    const pool = new Pool({ ...target, user: "nobody", password: "wrong" });
    try {
      await expect(requireDatabase(pool)).rejects.toThrow(
        new RegExp(
          `^PostgreSQL at ${target.host}:${target.port} refused user nobody .*TEST_DB_PORT=55432`,
        ),
      );
    } finally {
      await pool.end();
    }
  });
});
