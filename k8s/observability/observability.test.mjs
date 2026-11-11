// Checks on the observability stack of ARCHITECTURE D19, part a (#109, #55):
// what the rendered manifests must hold before they reach the cluster.
//
//   node --test k8s/observability/*.test.mjs   # needs kubectl and yq (mikefarah, v4) on PATH
//
// The manifests are rendered with `kubectl kustomize` and turned into JSON by
// yq, so the test reads exactly what `kubectl apply -k` would send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const NS = "observability";

function render() {
  const yaml = execFileSync("kubectl", ["kustomize", here], { encoding: "utf8" });
  const json = execFileSync("yq", ["-o=json", "-I=0", "."], { input: yaml, encoding: "utf8" });
  return json
    .split("\n")
    .filter((line) => line.trim() !== "" && line.trim() !== "null")
    .map((line) => JSON.parse(line));
}

const objects = render();
const byKind = (kind) => objects.filter((o) => o.kind === kind);
const find = (kind, name) => objects.find((o) => o.kind === kind && o.metadata.name === name);
const containersOf = (o) => [
  ...(o.spec.template.spec.initContainers ?? []),
  ...o.spec.template.spec.containers,
];
const workloads = () => objects.filter((o) => ["Deployment", "StatefulSet", "DaemonSet"].includes(o.kind));

// Kubernetes memory quantities used here: Mi, Gi, or plain bytes
function mebibytes(q) {
  const m = /^(\d+)(Mi|Gi)?$/.exec(String(q));
  assert.ok(m, `unsupported memory quantity ${q}`);
  const n = Number(m[1]);
  return m[2] === "Gi" ? n * 1024 : m[2] === "Mi" ? n : n / 2 ** 20;
}

test("renders Prometheus, kube-state-metrics and Grafana", () => {
  for (const name of ["prometheus", "kube-state-metrics", "grafana"]) {
    assert.ok(find("Deployment", name), `Deployment ${name} missing`);
    assert.ok(find("Service", name), `Service ${name} missing`);
  }
  assert.ok(find("Namespace", NS), "Namespace observability missing");
});

test("every namespaced object is in the observability namespace", () => {
  const clusterScoped = new Set(["Namespace", "ClusterRole", "ClusterRoleBinding"]);
  const stray = objects
    .filter((o) => !clusterScoped.has(o.kind) && o.metadata.namespace !== NS)
    .map((o) => `${o.kind}/${o.metadata.name}`);
  assert.deepEqual(stray, []);
});

test("nothing is exposed outside the cluster", () => {
  for (const svc of byKind("Service")) {
    assert.ok(!svc.spec.type || svc.spec.type === "ClusterIP", `${svc.metadata.name} is ${svc.spec.type}`);
  }
  for (const kind of ["Ingress", "HTTPRoute", "Gateway"]) assert.deepEqual(byKind(kind), []);
});

test("every image has a pinned version, never latest", () => {
  for (const w of workloads()) {
    for (const c of containersOf(w)) {
      assert.match(c.image, /:[^:/]+$/, `${w.metadata.name}/${c.name} has no tag`);
      assert.doesNotMatch(c.image, /:latest$/, `${w.metadata.name}/${c.name} uses latest`);
    }
  }
});

test("each container sets memory and CPU requests and a memory limit (OBS-5)", () => {
  for (const w of workloads()) {
    for (const c of containersOf(w)) {
      const r = c.resources ?? {};
      assert.ok(r.requests?.memory, `${w.metadata.name}/${c.name}: no memory request`);
      assert.ok(r.requests?.cpu, `${w.metadata.name}/${c.name}: no CPU request`);
      assert.ok(r.limits?.memory, `${w.metadata.name}/${c.name}: no memory limit`);
    }
  }
});

// Grafana measured 259 MiB in use, peak 264 MiB, once started at a 512 MiB limit
// (11 Nov 2026); at 192 MiB it was OOMKilled. Its official minimum is 512 MB.
test("memory requests match the D19 budget for part a: 480 MiB at most", () => {
  const budget = { prometheus: 192, "kube-state-metrics": 32, grafana: 256 };
  let total = 0;
  for (const [name, mi] of Object.entries(budget)) {
    const d = find("Deployment", name);
    const sum = containersOf(d).reduce((s, c) => s + mebibytes(c.resources.requests.memory), 0);
    assert.ok(sum <= mi, `${name} requests ${sum} MiB, budget ${mi}`);
    total += sum;
  }
  assert.ok(total <= 480, `part a requests ${total} MiB`);
});

test("one replica each, and containers run as non-root without privilege escalation", () => {
  for (const w of workloads()) {
    assert.equal(w.spec.replicas ?? 1, 1, `${w.metadata.name} replicas`);
    const pod = w.spec.template.spec;
    for (const c of containersOf(w)) {
      const nonRoot = c.securityContext?.runAsNonRoot ?? pod.securityContext?.runAsNonRoot;
      assert.equal(nonRoot, true, `${w.metadata.name}/${c.name} runAsNonRoot`);
      assert.equal(c.securityContext?.allowPrivilegeEscalation, false, `${w.metadata.name}/${c.name} allowPrivilegeEscalation`);
    }
  }
});

test("Prometheus keeps 24 hours, at most 1 GB, on an emptyDir", () => {
  const d = find("Deployment", "prometheus");
  const c = d.spec.template.spec.containers.find((x) => x.name === "prometheus");
  assert.ok(c.args.includes("--storage.tsdb.retention.time=24h"), "retention.time");
  assert.ok(c.args.includes("--storage.tsdb.retention.size=1GB"), "retention.size");
  const data = d.spec.template.spec.volumes.find((v) => v.name === "data");
  assert.ok(data?.emptyDir, "data volume is an emptyDir");
  assert.ok(data.emptyDir.sizeLimit, "emptyDir has a sizeLimit");
});

test("Prometheus may read nodes' metrics, but not proxy to them or read Secrets", () => {
  const role = find("ClusterRole", "prometheus");
  assert.ok(role, "ClusterRole prometheus missing");
  const resources = role.rules.flatMap((r) => r.resources);
  assert.ok(resources.includes("nodes/metrics"), "nodes/metrics");
  assert.ok(!resources.includes("nodes/proxy"), "nodes/proxy is not granted");
  assert.ok(!resources.includes("secrets"), "secrets are not granted");
  for (const r of role.rules) {
    assert.ok(r.verbs.every((v) => ["get", "list", "watch"].includes(v)), `write verb in ${r.resources}`);
  }
});

test("kube-state-metrics watches only HPAs (app namespace) and nodes", () => {
  const c = find("Deployment", "kube-state-metrics").spec.template.spec.containers[0];
  assert.ok(c.args.includes("--resources=horizontalpodautoscalers,nodes"), "--resources");
  const kinds = find("ClusterRole", "kube-state-metrics").rules.flatMap((r) => r.resources);
  assert.deepEqual(kinds.sort(), ["horizontalpodautoscalers", "nodes"]);
  assert.ok(c.args.includes("--namespaces=contentcollab"), "--namespaces");
});

test("Grafana takes its admin password from a Secret and phones nowhere", () => {
  const c = find("Deployment", "grafana").spec.template.spec.containers.find((x) => x.name === "grafana");
  const env = Object.fromEntries(c.env.map((e) => [e.name, e]));
  assert.equal(env.GF_SECURITY_ADMIN_PASSWORD?.valueFrom?.secretKeyRef?.name, "grafana-admin");
  assert.equal(env.GF_AUTH_ANONYMOUS_ENABLED?.value, "false");
  assert.equal(env.GF_ANALYTICS_REPORTING_ENABLED?.value, "false");
  assert.equal(env.GF_ANALYTICS_CHECK_FOR_UPDATES?.value, "false");
  // Grafana 13 otherwise downloads its preinstalled plugins from grafana.com at every start
  assert.equal(env.GF_PLUGINS_PREINSTALL_DISABLED?.value, "true");
  assert.equal(find("Secret", "grafana-admin"), undefined, "the password Secret is created by the install script, not committed");
});

test("Grafana has room to start: 512 MiB limit, a startup probe that outlasts its first start", () => {
  const c = find("Deployment", "grafana").spec.template.spec.containers.find((x) => x.name === "grafana");
  assert.ok(mebibytes(c.resources.limits.memory) >= 512, `limit ${c.resources.limits.memory}`);
  const sp = c.startupProbe;
  assert.ok(sp?.httpGet?.path === "/api/health", "startupProbe on /api/health");
  // About 60 s to first start at 1 CPU; allow five minutes
  assert.ok((sp.periodSeconds ?? 10) * (sp.failureThreshold ?? 3) >= 300, "startupProbe allows 300 s");
});

test("Grafana's Prometheus data source points at the Prometheus Service", () => {
  const cm = byKind("ConfigMap").find((m) => Object.keys(m.data ?? {}).includes("datasources.yaml"));
  assert.ok(cm, "datasources ConfigMap missing");
  const text = cm.data["datasources.yaml"];
  assert.match(text, /uid: prometheus/);
  assert.match(text, /url: http:\/\/prometheus\.observability\.svc:9090/);
  const svc = find("Service", "prometheus");
  assert.equal(svc.spec.ports[0].port, 9090);
});

test("the Prometheus config scrapes the api, the kubelet and kube-state-metrics", () => {
  const cm = byKind("ConfigMap").find((m) => Object.keys(m.data ?? {}).includes("prometheus.yml"));
  assert.ok(cm, "prometheus.yml ConfigMap missing");
  const text = cm.data["prometheus.yml"];
  for (const job of ["api", "kubelet-resource", "kubelet-cadvisor", "kube-state-metrics"]) {
    assert.match(text, new RegExp(`job_name: ${job}\\b`), `job ${job}`);
  }
  assert.match(text, /metrics_path: \/metrics\/resource/);
  assert.match(text, /metrics_path: \/metrics\/cadvisor/);
  assert.doesNotMatch(text, /insecure_skip_verify: true/, "kubelet TLS stays verified");
  // EndpointSlices also list not-ready and terminating pods; only ready ones are scraped
  assert.match(text, /__meta_kubernetes_endpointslice_endpoint_conditions_ready\][\s\S]*?regex: "?true"?/);
});

// The dashboard is plain JSON, read straight from the repository
const dashboard = JSON.parse(readFileSync(join(here, "grafana", "dashboards", "contentcollab.json"), "utf8"));
const exprsOf = (p) => (p.targets ?? []).map((t) => t.expr).join("\n");

test("the dashboard has the five panels of D19", () => {
  const titles = dashboard.panels.map((p) => p.title);
  const want = [/request rate/i, /5xx/i, /p95/i, /replicas/i, /node memory/i];
  for (const re of want) assert.ok(titles.some((t) => re.test(t)), `no panel matching ${re}`);
  for (const p of dashboard.panels) {
    assert.equal(p.datasource?.uid, "prometheus", `${p.title} datasource`);
    assert.ok(exprsOf(p).length > 0, `${p.title} has no query`);
  }
});

test("each panel queries the series its title names", () => {
  const panel = (re) => dashboard.panels.find((p) => re.test(p.title));
  assert.match(exprsOf(panel(/request rate/i)), /rate\(http_requests_total/);
  // http_errors_total has a route label both before and after PR #102
  assert.match(exprsOf(panel(/5xx/i)), /http_errors_total/);
  assert.match(exprsOf(panel(/5xx/i)), /by \(route\)/);
  // prom-client has no series for a labelled counter until it first counts, so
  // with no errors the share must be 0, not "No data"
  assert.match(exprsOf(panel(/5xx/i)), /\bor\b 0 \*/);
  // The scrape of /metrics and the readiness probe on /health are not traffic
  assert.match(exprsOf(panel(/request rate/i)), /route!~"\/metrics\|\/health"/);
  assert.match(exprsOf(panel(/p95/i)), /histogram_quantile\(0\.95,.*http_request_duration_seconds_bucket/s);
  assert.match(exprsOf(panel(/p95/i)), /\ble\b/);
  assert.match(exprsOf(panel(/replicas/i)), /kube_horizontalpodautoscaler_status_current_replicas/);
  assert.match(exprsOf(panel(/replicas/i)), /kube_horizontalpodautoscaler_status_desired_replicas/);
  assert.match(exprsOf(panel(/node memory/i)), /node_memory_working_set_bytes/);
  assert.match(exprsOf(panel(/node memory/i)), /kube_node_status_allocatable/);
});

// The label contract between prometheus.yml and the queries is tested by
// promtool against synthetic series (prometheus/dashboard.test.yml, run in CI);
// this keeps that file's expressions identical to the dashboard's.
test("every dashboard query is covered by the promtool expression tests", () => {
  const file = join(here, "prometheus", "dashboard.test.yml");
  assert.ok(existsSync(file), "prometheus/dashboard.test.yml missing");
  const yamlText = readFileSync(file, "utf8");
  const tested = JSON.parse(execFileSync("yq", ["-o=json", "-I=0", "[.tests[].promql_expr_test[].expr]"], { input: yamlText, encoding: "utf8" }));
  for (const p of dashboard.panels) {
    for (const t of p.targets) assert.ok(tested.includes(t.expr), `untested query in "${p.title}": ${t.expr}`);
  }
});

test("the dashboard is provisioned from the same file", () => {
  const cm = byKind("ConfigMap").find((m) => Object.keys(m.data ?? {}).includes("contentcollab.json"));
  assert.ok(cm, "dashboard ConfigMap missing");
  assert.deepEqual(JSON.parse(cm.data["contentcollab.json"]), dashboard);
});
