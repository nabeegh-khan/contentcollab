// Tests for the cross-replica check: reading connections from /proc/net/tcp, telling which pod took a socket, and the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEstablished, soleIncrease, crossReplicaCheck } from "./cross-replica-lib.mjs";

// /proc/net/tcp as a container prints it: header, then one line per socket; st 01 is ESTABLISHED, 0A is LISTEN
const PROC = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   1: 0A6D0020:0BB8 0A6D00DD:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 20 4 30 10 -1
   2: 0A6D0020:0BB8 0A6D00DD:A1B3 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 20 4 30 10 -1
   3: 0A6D0020:C3A4 0A6D008C:18EB 01 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 20 4 30 10 -1
   4: 0A6D0020:0BB8 0A6D00DD:A1B4 06 00000000:00000000 00:00000000 00000000  1000        0 55555 1 0000000000000000 20 4 30 10 -1
`;

test("parseEstablished counts only ESTABLISHED sockets on the API port", () => {
  assert.equal(parseEstablished(PROC, 3000), 2);
  assert.equal(parseEstablished(PROC, 6379), 0);
  assert.equal(parseEstablished("", 3000), 0);
});

test("soleIncrease names the one pod whose count went up", () => {
  const before = { "api-a": 2, "api-b": 5 };
  assert.equal(soleIncrease(before, { "api-a": 3, "api-b": 5 }), "api-a");
  assert.equal(soleIncrease(before, { "api-a": 2, "api-b": 6 }), "api-b");
});

test("soleIncrease gives null when no pod, or more than one pod, went up", () => {
  const before = { "api-a": 2, "api-b": 5 };
  assert.equal(soleIncrease(before, { "api-a": 2, "api-b": 5 }), null);
  assert.equal(soleIncrease(before, { "api-a": 3, "api-b": 6 }), null);
  assert.equal(soleIncrease(before, { "api-a": 1, "api-b": 5 }), null);
});

// A cluster in memory: sockets land on pods in the order given, counts follow
function world({ landing, deliver = () => true, pods = ["api-a", "api-b"] }) {
  const counts = Object.fromEntries(pods.map((p) => [p, 3]));
  const log = [];
  const opened = [];
  let nextLanding = 0;
  const deps = {
    log: (line) => log.push(line),
    login: async () => "tok",
    listPods: async () => pods,
    countConnections: async (pod) => counts[pod],
    openSocket: async () => {
      const pod = landing[nextLanding++ % landing.length];
      counts[pod] += 1;
      const socket = {
        closed: false,
        waitForComment: async (body) => {
          if (!deliver(pod, body)) throw new Error("timeout");
          return 12;
        },
        close() {
          this.closed = true;
        },
      };
      opened.push(socket);
      return socket;
    },
    postComment: async () => ({ id: "c1", body: "cross-replica-check" }),
    deleteComment: async () => {
      log.push("deleted c1");
    },
    maxSockets: 6,
  };
  return { deps, log, opened };
}

test("passes when sockets land on two pods and the comment reaches both", async () => {
  const { deps, opened, log } = world({ landing: ["api-a", "api-a", "api-b"] });
  const result = await crossReplicaCheck(deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pods.sort(), ["api-a", "api-b"]);
  assert.ok(opened.every((s) => s.closed), "every socket is closed");
  assert.ok(log.includes("deleted c1"), "the test comment is removed");
});

test("fails, saying so, when every socket lands on one pod", async () => {
  const { deps } = world({ landing: ["api-a"] });
  const result = await crossReplicaCheck(deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /one pod|two pods/i);
});

test("fails when the comment does not reach the socket on the other pod", async () => {
  const { deps } = world({ landing: ["api-a", "api-b"], deliver: (pod) => pod === "api-a" });
  const result = await crossReplicaCheck(deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /api-b/);
});

test("fails before opening anything when fewer than two API pods are ready", async () => {
  const { deps, opened } = world({ landing: ["api-a"], pods: ["api-a"] });
  const result = await crossReplicaCheck(deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /two/i);
  assert.equal(opened.length, 0);
});

test("still closes the sockets and removes the comment when delivery fails", async () => {
  const { deps, opened, log } = world({ landing: ["api-a", "api-b"], deliver: () => false });
  await crossReplicaCheck(deps);
  assert.ok(opened.every((s) => s.closed));
  assert.ok(log.includes("deleted c1"));
});
