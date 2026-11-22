// The autoscaler card (D31): replicas now and wanted, CPU against its target, and what limits it.
interface Metric {
  type?: string;
  resource?: {
    name?: string;
    target?: { averageUtilization?: number };
    current?: { averageUtilization?: number };
  };
}
interface Hpa {
  spec?: { minReplicas?: number; maxReplicas?: number; metrics?: Metric[] };
  status?: {
    currentReplicas?: number;
    desiredReplicas?: number;
    lastScaleTime?: string;
    currentMetrics?: Metric[];
    conditions?: { type?: string; status?: string; reason?: string }[];
  };
}

export interface HpaCard {
  name: string;
  currentReplicas: number;
  desiredReplicas: number;
  minReplicas: number;
  maxReplicas: number;
  cpuPercent: number | null;
  cpuTargetPercent: number | null;
  lastScaleTime: string | null;
  limitedBy: string | null;
}

const cpu = (metrics: Metric[] = []) =>
  metrics.find((m) => m.type === "Resource" && m.resource?.name === "cpu")?.resource;

export function hpaFrom(reply: unknown, name = "api"): HpaCard {
  const hpa = reply as Hpa | null;
  if (!hpa || typeof hpa.spec !== "object" || typeof hpa.status !== "object") {
    throw new Error("hpa: the reply was not the HorizontalPodAutoscaler");
  }
  const limited = hpa.status?.conditions?.find(
    (c) => c.type === "ScalingLimited" && c.status === "True",
  );
  return {
    name,
    currentReplicas: hpa.status?.currentReplicas ?? 0,
    desiredReplicas: hpa.status?.desiredReplicas ?? 0,
    minReplicas: hpa.spec?.minReplicas ?? 1,
    maxReplicas: hpa.spec?.maxReplicas ?? 0,
    cpuPercent: cpu(hpa.status?.currentMetrics)?.current?.averageUtilization ?? null,
    cpuTargetPercent: cpu(hpa.spec?.metrics)?.target?.averageUtilization ?? null,
    lastScaleTime: hpa.status?.lastScaleTime ?? null,
    limitedBy: limited?.reason ?? null,
  };
}
