// The node card (D31): CPU and memory as a percent of allocatable, as `kubectl top nodes` shows them.
import { parseCpuMillicores, parseMemoryMiB } from "./quantity.js";

const PERCENT = 100;

interface NodeList {
  items?: {
    metadata: { name: string };
    status?: { allocatable?: { cpu?: string; memory?: string } };
  }[];
}
interface MetricsList {
  items?: {
    metadata: { name: string };
    timestamp?: string;
    window?: string;
    usage?: { cpu?: string; memory?: string };
  }[];
}

export interface NodeCard {
  name: string;
  cpuPercent: number;
  memoryPercent: number;
  cpuMillicores: number;
  cpuAllocatableMillicores: number;
  memoryMiB: number;
  memoryAllocatableMiB: number;
  sampledAt: string | null;
  windowSeconds: number | null;
}

/** One row per node that has both an allocatable figure and a metrics sample. */
export function nodesFrom(nodeList: unknown, metricsList: unknown): NodeCard[] {
  const nodes = (nodeList as NodeList | null)?.items;
  const samples = (metricsList as MetricsList | null)?.items;
  if (!Array.isArray(nodes) || !Array.isArray(samples)) {
    throw new Error("nodes: the reply was not a node list");
  }
  return nodes.flatMap((node): NodeCard[] => {
    const sample = samples.find((s) => s.metadata.name === node.metadata.name);
    const allocatable = node.status?.allocatable;
    if (!sample?.usage?.cpu || !sample.usage.memory || !allocatable?.cpu || !allocatable.memory) {
      return [];
    }
    const cpuMillicores = parseCpuMillicores(sample.usage.cpu);
    const cpuAllocatableMillicores = parseCpuMillicores(allocatable.cpu);
    const memoryMiB = parseMemoryMiB(sample.usage.memory);
    const memoryAllocatableMiB = parseMemoryMiB(allocatable.memory);
    const window = sample.window ? Math.round(parseFloat(sample.window)) : NaN;
    return [
      {
        name: node.metadata.name,
        cpuPercent: Math.round((cpuMillicores / cpuAllocatableMillicores) * PERCENT),
        memoryPercent: Math.round((memoryMiB / memoryAllocatableMiB) * PERCENT),
        cpuMillicores,
        cpuAllocatableMillicores,
        memoryMiB,
        memoryAllocatableMiB,
        sampledAt: sample.timestamp ?? null,
        windowSeconds: Number.isFinite(window) ? window : null,
      },
    ];
  });
}
