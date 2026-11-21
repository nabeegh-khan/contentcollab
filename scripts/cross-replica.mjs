#!/usr/bin/env node
// Cross-replica check (sprint item 5): two Socket.IO clients through the public Gateway, held by two
// different API pods, join one version; a comment posted over REST must arrive on both.
//
//   $env:EMAIL="..."; $env:PASSWORD="..."; $env:DOCUMENT_ID="<uuid>"; $env:VERSION_ID="<uuid>"
//   node scripts/cross-replica.mjs
//
// kubectl's current context must be the cluster behind BASE. The user needs a share on the version
// (a role that may comment). The Gateway picks the pod for each connection, so the script opens
// sockets one at a time and attributes each to the pod whose ESTABLISHED connections on the API port
// rose (`kubectl exec <pod> -c api -- cat /proc/net/tcp /proc/net/tcp6`), until two pods hold one
// each. A socket it cannot attribute is not counted. The comment it posts is deleted afterwards.
// Optional: BASE (https://contentcollab.app), NAMESPACE (contentcollab), API_PORT (3000),
// MAX_SOCKETS (12), TIMEOUT_MS (10000), EVIDENCE_DIR (docs/evidence). The output also goes to
// <EVIDENCE_DIR>/<UTC date and time>-cross-replica.txt. Exit 0 on PASS, 1 on FAIL or a bad setting.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crossReplicaCheck, parseEstablished } from "./cross-replica-lib.mjs";

const run = promisify(execFile);
const env = process.env;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const missing = ["EMAIL", "PASSWORD", "DOCUMENT_ID", "VERSION_ID"].filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(`Missing settings: ${missing.join(", ")}`);
  process.exit(1);
}
if (!ID.test(env.DOCUMENT_ID) || !ID.test(env.VERSION_ID)) {
  console.error("DOCUMENT_ID and VERSION_ID must be ids like 123e4567-e89b-42d3-a456-426614174000");
  process.exit(1);
}

const BASE = (env.BASE ?? "https://contentcollab.app").replace(/\/$/, "");
const NS = env.NAMESPACE ?? "contentcollab";
const PORT = Number(env.API_PORT ?? 3000);
const TIMEOUT_MS = Number(env.TIMEOUT_MS ?? 10000);
const MAX_SOCKETS = Number(env.MAX_SOCKETS ?? 12);
const versionUrl = `${BASE}/api/v1/documents/${env.DOCUMENT_ID}/versions/${env.VERSION_ID}/comments`;

for (const [name, value] of [["API_PORT", PORT], ["TIMEOUT_MS", TIMEOUT_MS], ["MAX_SOCKETS", MAX_SOCKETS]]) {
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} must be a whole number of at least 1`);
    process.exit(1);
  }
}

const lines = [];
const log = (text) => {
  const line = `${new Date().toISOString()} ${text}`;
  lines.push(line);
  console.log(line);
};

// socket.io-client is the API's dependency: run `npm ci` in api/ first
const apiRequire = createRequire(fileURLToPath(new URL("../api/package.json", import.meta.url)));
const { io } = apiRequire("socket.io-client");

async function api(url, init, token) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} answered ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function listPods() {
  const { stdout } = await run("kubectl", ["-n", NS, "get", "pods", "-l", "app=api", "-o", "json"], {
    timeout: 30000,
  });
  return JSON.parse(stdout)
    .items.filter((pod) =>
      !pod.metadata.deletionTimestamp &&
        pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
    )
    .map((pod) => pod.metadata.name);
}

async function countConnections(pod) {
  const { stdout } = await run("kubectl", [
    "-n", NS, "exec", pod, "-c", "api", "--", "sh", "-c", "cat /proc/net/tcp /proc/net/tcp6",
  ], { timeout: 30000 });
  return parseEstablished(stdout, PORT);
}

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const seen = new Set(); // bodies of the comments this socket received
    const waiters = [];
    const socket = io(BASE, {
      path: "/socket.io",
      transports: ["websocket"],
      auth: { token },
      forceNew: true,
      reconnection: false, // a reconnect could move the socket to another pod and spoil the attribution
    });
    let dropped = false;
    socket.on("comment:created", (comment) => {
      seen.add(comment.body);
      for (const wake of waiters) wake(comment.body);
    });
    socket.on("disconnect", (reason) => {
      dropped = true;
      for (const wake of waiters) wake(null, `disconnected: ${reason}`);
    });
    const joinTimer = setTimeout(() => fail(new Error("join: no answer in time")), TIMEOUT_MS);
    const fail = (error) => {
      clearTimeout(joinTimer);
      socket.close();
      reject(error);
    };
    socket.on("connect_error", (error) => fail(new Error(`socket connect: ${error.message}`)));
    socket.on("connect", () =>
      socket.emit("join", { versionId: env.VERSION_ID }, (answer) => {
        clearTimeout(joinTimer);
        if (!answer?.ok) return fail(new Error(`join refused: ${answer?.code ?? "no answer"}`));
        resolve({
          close: () => socket.close(),
          waitForComment(body) {
            const started = Date.now();
            if (dropped) return Promise.reject(new Error("socket was disconnected"));
            if (seen.has(body)) return Promise.resolve(0);
            return new Promise((done, fail) => {
              const timer = setTimeout(() => fail(new Error("timeout")), TIMEOUT_MS);
              waiters.push((got, gone) => {
                if (gone) {
                  clearTimeout(timer);
                  fail(new Error(gone));
                  return;
                }
                if (got !== body) return;
                clearTimeout(timer);
                done(Date.now() - started);
              });
            });
          },
        });
      }),
    );
  });
}

const deps = {
  log,
  maxSockets: MAX_SOCKETS,
  listPods,
  countConnections,
  openSocket,
  login: async () => {
    const body = JSON.stringify({ email: env.EMAIL, password: env.PASSWORD });
    return (await api(`${BASE}/api/v1/auth/login`, { method: "POST", body }, null)).token;
  },
  postComment: async (token) => {
    const body = JSON.stringify({ body: `cross-replica-check ${new Date().toISOString()}` });
    const comment = await api(versionUrl, { method: "POST", body }, token);
    log(`posted comment ${comment.id}`);
    return comment;
  },
  deleteComment: async (token, comment) => {
    const url = `${BASE}/api/v1/documents/${env.DOCUMENT_ID}/comments/${comment.id}`;
    await api(url, { method: "DELETE" }, token);
    log(`deleted comment ${comment.id}`);
  },
};

let result;
try {
  log(`cross-replica check against ${BASE}, version ${env.VERSION_ID}`);
  result = await crossReplicaCheck(deps);
} catch (error) {
  result = { ok: false, reason: error.message, pods: [] };
}
log(
  result.ok
    ? `PASS: the comment reached sockets on ${result.pods.join(" and ")} (${result.latenciesMs.join(" ms and ")} ms after the post was read)`
    : `FAIL: ${result.reason}`,
);
if (result.cleanupFailed) log(`NOTE: the test comment could not be deleted: ${result.cleanupFailed}`);
const dir = env.EVIDENCE_DIR ?? "docs/evidence";
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = `${dir}/${stamp}-cross-replica.txt`;
writeFileSync(file, `${lines.join("\n")}\n`);
console.log(`written ${file}`);
process.exit(result.ok ? 0 : 1);
