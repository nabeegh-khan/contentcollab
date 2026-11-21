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
//
// DIRECT=1 (recommended): the two sockets are opened on two named API pods through `kubectl port-forward`,
// so no connection is counted and no pod has to be guessed; the comment is still posted through the
// public URL. It proves the Redis adapter carries an event between pods. The default (Gateway) mode counts
// ESTABLISHED connections, which the Gateway's short-lived HTTP connections can disturb: the first run on
// 21 Nov ended "attribution not confirmed" although both sockets had received the comment.

import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crossReplicaCheck, parseEstablished, parseForwardPort } from "./cross-replica-lib.mjs";

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

// `kubectl port-forward` to one pod on a free local port; resolves once kubectl prints the port it chose
const forwards = [];
function startForward(pod) {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", ["-n", NS, "port-forward", `pod/${pod}`, `:${PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    forwards.push(child);
    const timer = setTimeout(() => reject(new Error(`port-forward to ${pod}: no port within ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const port = parseForwardPort(output);
      if (port) {
        clearTimeout(timer);
        resolve(port);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`port-forward to ${pod} ended with code ${code}`));
    });
  });
}

// Ends every port-forward and waits for it to be gone. Exiting while a child's pipes were still closing
// made Node on Windows abort with a libuv assertion (exit code 3221226505) after a passing run, 21 Nov.
function stopForwards() {
  return Promise.all(
    forwards.map(
      (child) =>
        new Promise((done) => {
          if (child.exitCode !== null || child.signalCode !== null) return done();
          const timer = setTimeout(done, 3000);
          child.once("exit", () => {
            clearTimeout(timer);
            done();
          });
          child.stdout.destroy();
          child.stderr.destroy();
          child.kill();
        }),
    ),
  );
}

// Direct mode: one socket on each of the first two ready pods, so which pod holds which is known
async function placeDirect(pods, token, placed) {
  const byPod = new Map();
  for (const pod of pods.slice(0, 2)) {
    const port = await startForward(pod);
    log(`port-forward to ${pod} on 127.0.0.1:${port}`);
    const socket = await openSocket(token, `http://127.0.0.1:${port}`);
    placed.push(socket);
    byPod.set(pod, { socket });
  }
  return byPod;
}

function openSocket(token, url = BASE) {
  return new Promise((resolve, reject) => {
    const seen = new Set(); // bodies of the comments this socket received
    const waiters = [];
    const socket = io(url, {
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
  ...(env.DIRECT === "1" ? { placeDirect } : {}),
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
  log(`cross-replica check against ${BASE}, version ${env.VERSION_ID}, mode ${env.DIRECT === "1" ? "direct (port-forward)" : "gateway (attributed by connection counts)"}`);
  result = await crossReplicaCheck(deps);
} catch (error) {
  result = { ok: false, reason: error.message, pods: [] };
} finally {
  await stopForwards();
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
// Let Node end by itself once its handles have closed: calling process.exit() while they were still
// closing aborted it on Windows after a passing run (libuv assertion, exit code 3221226505, 21 Nov).
// The timer is a backstop only (unref'd, so it never keeps the process alive).
process.exitCode = result.ok ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 10000).unref();
