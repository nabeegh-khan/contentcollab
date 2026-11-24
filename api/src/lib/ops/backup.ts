// The nightly backup (D30, D35): when it last ran, when it last succeeded, and how the newest run ended.
const CRON_JOB = "db-backup";

export type RunResult = "Succeeded" | "Failed" | "Running";

export interface BackupRun {
  name: string;
  result: RunResult;
  finishedAt: string | null;
}

export interface BackupCard {
  schedule: string | null;
  lastScheduledAt: string | null;
  lastSucceededAt: string | null;
  lastRun: BackupRun | null;
}

interface Condition {
  type?: string;
  status?: string;
  lastTransitionTime?: string;
}
interface Job {
  metadata: {
    name: string;
    creationTimestamp?: string;
    ownerReferences?: { kind?: string; name?: string }[];
  };
  status?: { completionTime?: string; conditions?: Condition[] };
}

const condition = (job: Job, type: string) =>
  job.status?.conditions?.find((c) => c.type === type && c.status === "True");

function runOf(job: Job): BackupRun {
  const name = job.metadata.name;
  const done = condition(job, "Complete");
  if (done) {
    const finishedAt = job.status?.completionTime ?? done.lastTransitionTime ?? null;
    return { name, result: "Succeeded", finishedAt };
  }
  const failed = condition(job, "Failed");
  if (failed) return { name, result: "Failed", finishedAt: failed.lastTransitionTime ?? null };
  return { name, result: "Running", finishedAt: null };
}

const createdAt = (job: Job) => Date.parse(job.metadata.creationTimestamp ?? "");
const ownedByBackup = (job: Job) =>
  job.metadata.ownerReferences?.some((o) => o.kind === "CronJob" && o.name === CRON_JOB) === true;

/** The CronJob's own times plus the newest Job it created; both replies are checked, not assumed. */
export function backupFrom(cronJob: unknown, jobList: unknown): BackupCard {
  const cron = cronJob as { spec?: { schedule?: string }; status?: Record<string, string> } | null;
  if (!cron || typeof cron.spec !== "object") {
    throw new Error("backup: the reply was not the CronJob");
  }
  const jobs = (jobList as { items?: Job[] } | null)?.items;
  if (!Array.isArray(jobs)) throw new Error("backup: the jobs reply was not a list");
  const newest = jobs.filter(ownedByBackup).sort((a, b) => createdAt(b) - createdAt(a))[0];
  return {
    schedule: cron.spec?.schedule ?? null,
    lastScheduledAt: cron.status?.lastScheduleTime ?? null,
    lastSucceededAt: cron.status?.lastSuccessfulTime ?? null,
    lastRun: newest ? runOf(newest) : null,
  };
}
