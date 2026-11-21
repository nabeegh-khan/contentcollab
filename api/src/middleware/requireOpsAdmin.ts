import type { RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "../lib/httpError.js";
import { HTTP_FORBIDDEN, HTTP_UNAUTHORIZED } from "../lib/httpStatus.js";
import { log } from "../lib/log.js";

// Who may open the operations panel (D31): the ids in OPS_ADMIN_USER_IDS, a comma-separated list kept in
// the cluster Secret. No database query, so it still answers while PostgreSQL restarts; unset or empty
// means nobody is an admin. Mounted after requireAuth, which sets res.locals.userId.

const reported = new Set<string>();

/** The listed ids, lower-cased; an entry that is not a UUID is skipped and named once in a warn line. */
export function opsAdminIds(env: Record<string, string | undefined>): Set<string> {
  const entries = (env.OPS_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const valid = entries.filter((entry) => z.uuid().safeParse(entry).success);
  entries
    .filter((entry) => !valid.includes(entry) && !reported.has(entry))
    .forEach((entry) => {
      reported.add(entry);
      log("warn", "OPS_ADMIN_USER_IDS: an entry is not a UUID and was skipped", {
        component: "ops",
      });
    });
  return new Set(valid.map((id) => id.toLowerCase()));
}

export function requireOpsAdmin(
  env: Record<string, string | undefined> = process.env,
): RequestHandler {
  return (_req, res, next) => {
    const userId = res.locals.userId as string | undefined;
    if (!userId) throw new HttpError(HTTP_UNAUTHORIZED, "UNAUTHORIZED", "Unauthorized");
    if (!opsAdminIds(env).has(userId.toLowerCase())) {
      throw new HttpError(HTTP_FORBIDDEN, "FORBIDDEN", "Forbidden");
    }
    next();
  };
}
