import { Queue } from "bullmq";
import { connection } from "./redis.js";

// One queue for every job type; the job name says which handler runs.
// The API adds jobs with the same name and connection settings.
export const QUEUE_NAME = "contentcollab";

export const queue = new Queue(QUEUE_NAME, { connection });
