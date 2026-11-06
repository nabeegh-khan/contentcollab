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

  const active = (status.conditions ?? []).find((c) => c.type === "ScalingActive");
  if (active?.status !== "True") {
    return { ok: false, reason: `ScalingActive is not True (${active?.reason ?? "no condition"})` };
  }

  const cpu = (status.currentMetrics ?? []).find(
    (m) => m.type === "Resource" && m.resource?.name === "cpu",
  );
  const utilization = cpu?.resource?.current?.averageUtilization;
  if (typeof utilization !== "number") return { ok: false, reason: "no cpu utilization reported yet" };

  return { ok: true, reason: `cpu ${utilization}%` };
}

/** Reads the HPA through kubectl; null when kubectl or the cluster is unreachable. */
export function readHpa(namespace = "contentcollab", name = "api") {
  try {
    const out = execFileSync("kubectl", ["-n", namespace, "get", "hpa", name, "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ns = process.env.NAMESPACE ?? "contentcollab";
  const name = process.env.HPA ?? "api";
  const hpa = readHpa(ns, name);
  if (!hpa) {
    console.error(`cannot read hpa/${name} in ${ns}: is kubectl pointed at the cluster?`);
    process.exit(1);
  }
  const { ok, reason } = hpaReadiness(hpa);
  console.log(`hpa/${name}: ${ok ? "reading cpu" : "NOT READY"}: ${reason}`);
  process.exit(ok ? 0 : 1);
}
