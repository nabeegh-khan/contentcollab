// Tests for hpa-ready.mjs: the load test must not start while the HPA cannot read CPU (#69).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hpaReadiness } from "./hpa-ready.mjs";

// Status of hpa/api on DOKS, 6 Nov 2026, before metrics-server was installed
const withoutMetricsServer = {
  status: {
    conditions: [
      { type: "AbleToScale", status: "True", reason: "SucceededGetScale" },
      {
        type: "ScalingActive",
        status: "False",
        reason: "FailedGetResourceMetric",
        message:
          "the HPA was unable to compute the replica count: failed to get cpu utilization: unable to get metrics for resource cpu: unable to fetch metrics from resource metrics API: the server could not find the requested resource (get pods.metrics.k8s.io)",
      },
    ],
    currentMetrics: [{ type: "" }],
    currentReplicas: 2,
    desiredReplicas: 0,
  },
};

// Shape of an autoscaling/v2 status once the resource metrics API answers
const reading = {
  status: {
    conditions: [
      { type: "AbleToScale", status: "True", reason: "ReadyForNewScale" },
      { type: "ScalingActive", status: "True", reason: "ValidMetricFound" },
    ],
    currentMetrics: [
      { type: "Resource", resource: { name: "cpu", current: { averageUtilization: 3, averageValue: "3m" } } },
    ],
    currentReplicas: 2,
    desiredReplicas: 2,
  },
};

test("not ready when the resource metrics API is missing", () => {
  const r = hpaReadiness(withoutMetricsServer);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ScalingActive is not True (FailedGetResourceMetric)");
});

test("ready when ScalingActive is True and CPU utilization is reported", () => {
  assert.deepEqual(hpaReadiness(reading), { ok: true, reason: "cpu 3%" });
});

test("not ready when ScalingActive is True but no CPU reading yet", () => {
  const r = hpaReadiness({ status: { ...reading.status, currentMetrics: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no cpu utilization reported yet");
});

test("not ready when the HPA cannot scale its target", () => {
  const conditions = [{ type: "AbleToScale", status: "False", reason: "FailedGetScale" }, reading.status.conditions[1]];
  const r = hpaReadiness({ status: { ...reading.status, conditions } });
  assert.deepEqual(r, { ok: false, reason: "AbleToScale is not True (FailedGetScale)" });
});

test("not ready when the HPA has no status", () => {
  assert.equal(hpaReadiness({}).ok, false);
  assert.equal(hpaReadiness(null).ok, false);
});
