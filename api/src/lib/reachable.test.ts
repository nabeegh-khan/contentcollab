import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { createServer, type AddressInfo, type Server } from "node:net";
import { reachable, requireServices } from "./reachable.js";

// A real listener on an ephemeral port stands in for PostgreSQL or Redis; a
// port that was listening and then closed stands in for a service that is down.
let server: Server;
let openPort: number;
let closedPort: number;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openPort = (server.address() as AddressInfo).port;
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  closedPort = (other.address() as AddressInfo).port;
  await new Promise<void>((resolve) => other.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("reachable", () => {
  it("is true for a port that accepts connections", async () => {
    expect(await reachable("127.0.0.1", openPort, 1000)).toBe(true);
  });
  it("is false for a port nothing listens on", async () => {
    expect(await reachable("127.0.0.1", closedPort, 1000)).toBe(false);
  });
});

describe("requireServices", () => {
  it("resolves when every service answers", async () => {
    await expect(
      requireServices([{ name: "PostgreSQL", host: "127.0.0.1", port: openPort }], 1000),
    ).resolves.toBeUndefined();
  });
  it("names each unreachable service with host and port, and the command that starts them", async () => {
    await expect(
      requireServices(
        [
          { name: "PostgreSQL", host: "127.0.0.1", port: closedPort },
          { name: "Redis", host: "127.0.0.1", port: openPort },
        ],
        1000,
      ),
    ).rejects.toThrow(
      `PostgreSQL unreachable at 127.0.0.1:${closedPort}. Start the services first: docker compose -f compose.yaml -f compose.test.yaml up -d db redis`,
    );
  });
});
