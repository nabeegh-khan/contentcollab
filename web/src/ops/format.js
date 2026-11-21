// Words and shapes for the operations page (D31): plain sentences, and a shape beside every state word.
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1000;
const SLOW_SECONDS = 1;

const VIEWS = {
  Running: { label: "Running", shape: "●" },
  Starting: { label: "Starting", shape: "◐" },
  Stopping: { label: "Stopping", shape: "↻" },
  Restarting: { label: "Restarting", shape: "↻" },
  Failed: { label: "Failed", shape: "✖" },
  Unknown: { label: "Unknown", shape: "?" },
};

/** A state as a word plus a shape, so colour is never the only signal. */
export function statusView(status) {
  return VIEWS[status] ?? VIEWS.Unknown;
}

/** "45 s", "16 min", "2 h 5 min". */
export function ageText(seconds) {
  if (seconds === null || seconds === undefined) return "unknown";
  if (seconds < SECONDS_PER_MINUTE) return `${seconds} s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min`;
  const rest = minutes % MINUTES_PER_HOUR;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "just now", "3 s ago", "2 min ago", from a number of milliseconds. */
export function agoText(milliseconds) {
  const seconds = Math.floor(milliseconds / MS_PER_SECOND);
  if (seconds <= 0) return "just now";
  if (seconds < SECONDS_PER_MINUTE) return `${seconds} s ago`;
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)} min ago`;
}

export function cpuLine({ cpuPercent, cpuTargetPercent }) {
  if (cpuPercent === null || cpuPercent === undefined) return "CPU not read yet";
  if (
    cpuTargetPercent !== null &&
    cpuTargetPercent !== undefined &&
    cpuPercent > cpuTargetPercent
  ) {
    return `CPU ${cpuPercent}%: above the ${cpuTargetPercent}% target, the autoscaler is adding copies`;
  }
  return `CPU ${cpuPercent}% (scales out above ${cpuTargetPercent}%)`;
}

export function latencyText(p95Seconds) {
  if (p95Seconds === null || p95Seconds === undefined) return "no requests in the last minute";
  if (p95Seconds < SLOW_SECONDS) {
    return `Slowest 5% took under ${Math.round(p95Seconds * MS_PER_SECOND)} ms`;
  }
  return `Slowest 5% took under ${Math.round(p95Seconds * 10) / 10} s`;
}

const nameOf = (object) =>
  String(object ?? "")
    .split("/")
    .pop();

/** One Kubernetes event as a sentence for an audience. Text is returned as text, never as markup. */
export function eventSentence(event) {
  const name = nameOf(event.object);
  switch (event.reason) {
    case "Started":
      return `Kubernetes started a new pod (${name})`;
    case "Killing":
      return `Kubernetes stopped a pod (${name})`;
    case "Scheduled":
      return `Kubernetes placed a pod on a node (${name})`;
    case "Unhealthy":
      return `A health check failed (${name})`;
    case "Evicted":
      return `A pod was evicted (${name})`;
    case "FailedScheduling":
      return `Kubernetes could not place a pod (${name})`;
    case "SuccessfulCreate":
      return "A controller created a pod";
    case "SuccessfulDelete":
      return "A controller removed a pod";
    case "ScalingReplicaSet":
      return "A rollout changed the number of pods";
    case "SuccessfulRescale": {
      const size = /New size: (\d+)/.exec(event.text ?? "")?.[1];
      return size
        ? `The autoscaler changed the API to ${size} pods`
        : "The autoscaler resized the API";
    }
    default:
      return `${event.object}: ${event.text}`;
  }
}
