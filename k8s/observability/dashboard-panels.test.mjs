// Checks on how the Grafana panels draw (demo polish, 24 Nov). They read the dashboard JSON only, so they run
// without kubectl or yq:
//
//   node --test k8s/observability/dashboard-panels.test.mjs
//
// Cause found on the live cluster on 24 Nov: the ratio never went above 0.16 in three days, so the 10000% axis
// was Grafana's default 0..100 range for a panel whose series are all 0 or NaN, shown through unit percentunit.
// The "current" replicas line did exist (value 2) but "desired" is also 2 and was drawn over it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = JSON.parse(readFileSync(join(here, "grafana", "dashboards", "contentcollab.json"), "utf8"));
const panel = (re) => dashboard.panels.find((p) => re.test(p.title));

test("the 5xx share panel is a 0 to 100% axis that cannot run to 10000%", () => {
  const defaults = panel(/5xx/i).fieldConfig.defaults;
  assert.equal(defaults.unit, "percentunit", "the query is a 0..1 ratio, so percentunit (not percent)");
  assert.equal(defaults.min, 0);
  assert.equal(defaults.max, 1, "a fixed top of 100% (1 in percentunit)");
});

test("the 5xx share query does not multiply by 100 as well as using percentunit", () => {
  const expr = panel(/5xx/i).targets.map((t) => t.expr).join("\n");
  assert.doesNotMatch(expr, /\*\s*100\b/);
});

test("the replicas panel draws current, desired and maximum with different line styles", () => {
  const replicas = panel(/replicas/i);
  const byName = (name) => replicas.fieldConfig.overrides.find((o) => o.matcher.options === name);
  const styleOf = (name) => {
    const props = Object.fromEntries((byName(name)?.properties ?? []).map((p) => [p.id, p.value]));
    return JSON.stringify([props["custom.lineWidth"], props["custom.lineStyle"]]);
  };
  for (const name of ["current", "desired", "maximum"]) {
    assert.ok(byName(name), `no override for the "${name}" series`);
    assert.equal(byName(name).matcher.id, "byName");
  }
  assert.equal(new Set(["current", "desired", "maximum"].map(styleOf)).size, 3, "three distinct styles");
  // "current" is the one that was hidden: it is thicker, so it still shows under "desired" when both are 2
  const width = (name) => Object.fromEntries(byName(name).properties.map((p) => [p.id, p.value]))["custom.lineWidth"];
  assert.ok(width("current") > width("desired"));
});

test("the replicas panel still queries the series its legend names, with the labels kube-state-metrics gives", () => {
  const targets = panel(/replicas/i).targets;
  assert.deepEqual(
    targets.map((t) => t.legendFormat),
    ["current", "desired", "maximum"],
  );
  for (const t of targets) assert.match(t.expr, /horizontalpodautoscaler="api"/);
});
