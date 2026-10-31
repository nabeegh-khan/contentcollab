import { Router } from "express";
import { registry } from "../lib/metrics.js";

const router = Router();

// Cluster-internal (docs/API.md, Operations): the Gateway never routes
// /metrics, so only the scraper inside the cluster reaches it.
router.get("/", async (req, res) => {
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

export default router;
