// Says whether the API's HPA can read CPU, so a load test never runs against an autoscaler that cannot scale (#69).
//
//   node scripts/hpa-ready.mjs          # exits 1 with the reason if hpa/api cannot read CPU
//   NAMESPACE=... HPA=... node scripts/hpa-ready.mjs
//
// The HPA needs the resource metrics API, which DOKS provides only once
// metrics-server is installed (scripts/metrics-server.sh, ARCHITECTURE D5).

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * @param {object|null} hpa an autoscaling/v2 HorizontalPodAutoscaler as `kubectl get hpa -o json` prints it
 * @returns {{ok: boolean, reason: string}}
 */
export function hpaReadiness(hpa) {
  const status = hpa?.status;
  if (!status) return { ok: false, reason: "HPA has no status yet" };

  for (const type of ["AbleToScale", "ScalingActive"]) {
    const c = (status.conditions ?? []).find((x) => x.type === type);
    if (c?.status !== "True") return { ok: false, reason: `${type} is not True (${c?.reason ?? "no condition"})` };
  }

  const cpu = (status.currentMetrics ?? []).find(
    (m) => m.type === "Resource" && m.resource?.name === "cpu",
  );
  const utilization = cpu?.resource?.current?.averageUtilization;
  if (typeof utilization !== "number") return { ok: false, reason: "no cpu utilization reported yet" };

  return { ok: true, reason: `cpu ${utilization}%` };
}

const UNREACHABLE = /Unable to connect|connection refused|no such host|dial tcp|i\/o timeout|no configuration has been provided/i;

/**
 * Reads the HPA through kubectl.
 * @returns {{hpa: object} | {unreachable: true, error: string} | {unreachable: false, error: string}}
 *   unreachable: kubectl missing or no cluster (fine for a local run); otherwise a real error (wrong namespace, no HPA, no access)
 */
export function readHpa(namespace = "contentcollab", name = "api") {
  try {
    const out = execFileSync("kubectl", ["-n", namespace, "get", "hpa", name, "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { hpa: JSON.parse(out) };
  } catch (e) {
    const error = String(e.stderr ?? e.message).trim();
    return { unreachable: e.code === "ENOENT" || UNREACHABLE.test(error), error };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ns = process.env.NAMESPACE ?? "contentcollab";
  const name = process.env.HPA ?? "api";
  const read = readHpa(ns, name);
  if (!read.hpa) {
    console.error(`cannot read hpa/${name} in ${ns}: ${read.error}`);
    process.exit(1);
  }
  const { ok, reason } = hpaReadiness(read.hpa);
  console.log(`hpa/${name}: ${ok ? "reading cpu" : "NOT READY"}: ${reason}`);
  process.exit(ok ? 0 : 1);
}
