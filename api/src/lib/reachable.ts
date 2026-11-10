import { createConnection } from "node:net";

// The tests run against a real PostgreSQL and Redis. A plain TCP connect tells
// in under a second whether each one is there; the clients' own retries would
// hide the cause behind a hook timeout.
export function reachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface Service {
  name: string;
  host: string;
  port: number;
}

export const START_SERVICES = "docker compose -f compose.yaml -f compose.test.yaml up -d db redis";

// Throws one error naming every service that did not answer, so a local run
// says what to start instead of timing out.
export async function requireServices(services: Service[], timeoutMs: number): Promise<void> {
  const results = await Promise.all(services.map((s) => reachable(s.host, s.port, timeoutMs)));
  const down = services.filter((_, i) => !results[i]);
  if (down.length > 0) {
    const list = down.map((s) => `${s.name} unreachable at ${s.host}:${s.port}`).join("; ");
    throw new Error(`${list}. Start the services first: ${START_SERVICES}`);
  }
}
