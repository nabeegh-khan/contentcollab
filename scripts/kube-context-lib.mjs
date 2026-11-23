// Stops a Node script that acts on kubectl's current context unless it is the one the caller named (#106, D32, INF-20).
import { execFileSync } from "node:child_process";

/**
 * @param {{expected?: string, current?: string, writes: boolean}} p expected is KUBE_CONTEXT; writes is true when the run changes the cluster
 * @returns {{ok: boolean, message: string}} message is what to print: the reason to stop, or (ok) a line naming the context in use, or "" when there is nothing to say
 */
export function checkKubeContext({ expected = "", current = "", writes }) {
  if (!expected) {
    if (writes) {
      return {
        ok: false,
        message: `set KUBE_CONTEXT to the cluster this run may change (kubectl config get-contexts); kubectl's current context is ${current || "not set"}`,
      };
    }
    if (!current) return { ok: true, message: "" };
    return { ok: true, message: `kubectl context: ${current} (set KUBE_CONTEXT to check it)` };
  }
  if (current === expected) return { ok: true, message: `kubectl context: ${current}` };
  return {
    ok: false,
    message: `kubectl's current context is ${current ? `"${current}"` : "not set"}, not "${expected}" (KUBE_CONTEXT): run kubectl config use-context ${expected}`,
  };
}

/** kubectl's current context, or "" when kubectl is missing or has none. */
export function currentContext() {
  try {
    return execFileSync("kubectl", ["config", "current-context"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Checks KUBE_CONTEXT against the current context; prints the outcome on stderr and exits 1 when the run must not go on. */
export function requireKubeContext({ writes, env = process.env }) {
  const { ok, message } = checkKubeContext({ expected: env.KUBE_CONTEXT ?? "", current: currentContext(), writes });
  if (message) console.error(ok ? message : `stopping: ${message}`);
  if (!ok) process.exit(1);
}
