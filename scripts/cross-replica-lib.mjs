// Logic of the cross-replica check (sprint item 5): two sockets on different API pods both get a comment.
// No I/O here: cross-replica.mjs supplies kubectl, fetch and socket.io-client, tests supply stand-ins.

// Count of ESTABLISHED sockets whose local port is `port`, from /proc/net/tcp (or tcp6) text
export function parseEstablished(text, port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  let count = 0;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || !/^\d+:$/.test(fields[0])) continue;
    const localPort = fields[1].split(":")[1];
    if (localPort === hexPort && fields[3] === "01") count += 1;
  }
  return count;
}

// The one pod whose count went up between two readings, or null when none or several did
export function soleIncrease(before, after) {
  const up = Object.keys(after).filter((pod) => after[pod] > (before[pod] ?? 0));
  return up.length === 1 ? up[0] : null;
}

async function counts(deps, pods) {
  const entries = await Promise.all(pods.map(async (pod) => [pod, await deps.countConnections(pod)]));
  return Object.fromEntries(entries);
}

// Opens sockets one at a time, attributing each to a pod by the connection that appeared there,
// until two pods each hold one. Fills `placed` as it goes so a throw part-way can still close them.
// byPod maps a pod to { socket, floor }: floor is the count that pod must still hold if it has the socket
async function placeSockets(deps, pods, token, placed) {
  const byPod = new Map();
  for (let i = 0; i < deps.maxSockets && byPod.size < 2; i += 1) {
    const before = await counts(deps, pods);
    const socket = await deps.openSocket(token);
    placed.push(socket);
    const after = await counts(deps, pods);
    const pod = soleIncrease(before, after);
    deps.log(`socket ${i + 1}: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    if (!pod) deps.log(`socket ${i + 1}: pod not identified`);
    else if (byPod.has(pod)) deps.log(`socket ${i + 1}: landed on ${pod} again`);
    else {
      byPod.set(pod, { socket, floor: before[pod] + 1 });
      deps.log(`socket ${i + 1}: ${pod}`);
    }
  }
  return byPod;
}

// Returns { ok, reason?, pods, latenciesMs, cleanupFailed? }. Closes the sockets it opened and removes its comment.
export async function crossReplicaCheck(deps) {
  const pods = await deps.listPods();
  if (pods.length < 2) {
    return { ok: false, reason: `need two ready API pods, found ${pods.length}`, pods: [] };
  }
  const token = await deps.login();
  const placed = [];
  let comment = null;
  let outcome = null;
  try {
    const byPod = await placeSockets(deps, pods, token, placed);
    if (byPod.size < 2) {
      return {
        ok: false,
        reason: `after ${placed.length} sockets only one pod was reached or sockets could not be attributed; two pods are needed`,
        pods: [...byPod.keys()],
      };
    }
    comment = await deps.postComment(token);
    const names = [...byPod.keys()];
    const outcomes = await Promise.allSettled(
      names.map((pod) => byPod.get(pod).socket.waitForComment(comment.body)),
    );
    const missed = names.filter((_, i) => outcomes[i].status === "rejected");
    if (missed.length > 0) {
      return {
        ok: false,
        reason: `the comment did not reach the socket on ${missed.join(", ")}`,
        pods: names,
      };
    }
    // The attribution came from a connection count; check each pod still holds its socket now
    const now = await counts(deps, names);
    const lost = names.filter((pod) => now[pod] < byPod.get(pod).floor);
    if (lost.length > 0) {
      return {
        ok: false,
        reason: `attribution not confirmed: ${lost.join(", ")} no longer holds the connection it was credited with (${JSON.stringify(now)})`,
        pods: names,
      };
    }
    outcome = { ok: true, pods: names, latenciesMs: outcomes.map((o) => o.value) };
    return outcome;
  } catch (error) {
    return { ok: false, reason: error.message, pods: [] };
  } finally {
    for (const socket of placed) socket.close();
    if (comment) {
      try {
        await deps.deleteComment(token, comment);
      } catch (error) {
        deps.log(`cleanup failed: comment ${comment.id} was left behind (${error.message})`);
        if (outcome) outcome.cleanupFailed = error.message;
      }
    }
  }
}
