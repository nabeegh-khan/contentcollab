import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "pg";

const run = promisify(exec);
const POSTGRES_PORT = 5432;
const SUFFIX_BYTES = 6;

// The server the test database lives on (jest.env.js: the CI service container
// or the one compose.test.yaml publishes). Scratch databases are made beside
// it, so nothing here touches the tables the other tests use.
const server = {
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? POSTGRES_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};

export async function connect(database: string): Promise<Client> {
  const client = new Client({ ...server, database });
  await client.connect();
  return client;
}

async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect("postgres");
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// A new empty database, or a copy of `template` (which must have no connections)
export async function createDatabase(template?: string): Promise<string> {
  const name = `contract_${randomBytes(SUFFIX_BYTES).toString("hex")}`;
  await admin((client) =>
    client.query(`CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ""}`),
  );
  return name;
}

export async function dropDatabase(name: string): Promise<void> {
  await admin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

export function databaseUrl(database: string): string {
  const credentials = `${encodeURIComponent(server.user ?? "")}:${encodeURIComponent(server.password ?? "")}`;
  return `postgres://${credentials}@${server.host}:${server.port}/${database}`;
}

// Runs a migrate command from api/ against `database`; resolves with its output
export async function migrate(command: string, database: string): Promise<string> {
  const { stdout, stderr } = await run(command, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl(database) },
  });
  return `${stdout}${stderr}`;
}
