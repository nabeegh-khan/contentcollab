import { Router } from "express";

// Version comparison (#23, ARCHITECTURE D21). Mounted only when FEATURE_VERSION_COMPARE=1. The worker
// computes the diff (worker/src/jobs/versionDiff.ts); this route cannot read versions until they are
// stored (#116), so it answers 501 in the API's error shape. Not in docs/API.md until it returns data.
const NOT_IMPLEMENTED = 501;

export const compareEnabled = (env: Record<string, string | undefined>): boolean =>
  env.FEATURE_VERSION_COMPARE === "1";

const router = Router();

router.get("/:documentId/versions/:versionId/compare", (_req, res) => {
  res.status(NOT_IMPLEMENTED).json({ error: "Not Implemented", code: "NOT_IMPLEMENTED" });
});

export default router;
