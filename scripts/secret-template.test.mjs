// The app Secret is a template in Git and a real object only in the cluster (#53; SEC-1, SEC-2, SEC-10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { flatSection, secretReferences, scanManifest, problems, PLACEHOLDER } from "./secret-template-lib.mjs";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const template = `# comment
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
type: Opaque
stringData:
  DB_USER: REPLACE_ME
  DB_PASSWORD: "REPLACE_ME"
  SPACES_KEY: 'REPLACE_ME'
`;
const configMap = "kind: ConfigMap\nmetadata:\n  name: app-config\ndata:\n  PORT: \"3000\"\n";
const deployment = (name, refs) => `kind: Deployment\nmetadata:\n  name: ${name}\nspec:\n  template:\n    spec:\n      containers:\n        - name: c\n${refs}`;
const envFrom = "          envFrom:\n            - secretRef:\n                name: app-secrets\n";
const keyRef = (key) =>
  `          env:\n            - name: X\n              valueFrom:\n                secretKeyRef:\n                  name: app-secrets\n                  key: ${key}\n`;
const check = (manifests, extra = {}) =>
  problems({ templateText: template, configMapText: configMap, manifests, ...extra });

test("flatSection reads quoted and bare values, ignores comments, tolerates CRLF", () => {
  assert.deepEqual(flatSection(template.replace(/\n/g, "\r\n"), "stringData"), {
    DB_USER: PLACEHOLDER,
    DB_PASSWORD: PLACEHOLDER,
    SPACES_KEY: PLACEHOLDER,
  });
  assert.equal(flatSection(template, "data"), null);
});

test("flatSection drops a trailing comment but keeps a # inside quotes", () => {
  const text = 'stringData:\n  A: REPLACE_ME      # note\n  B: "x # y"  # note\n  C: \'p\'\n';
  assert.deepEqual(flatSection(text, "stringData"), { A: "REPLACE_ME", B: "x # y", C: "p" });
});

test("secretReferences finds block references and refuses flow style", () => {
  const refs = secretReferences(deployment("api", envFrom + keyRef("DB_USER")));
  assert.deepEqual(refs.wholeRefs, [{ secret: "app-secrets", via: "envFrom" }]);
  assert.deepEqual(refs.keyRefs, [{ secret: "app-secrets", key: "DB_USER" }]);
  assert.throws(() => secretReferences("          valueFrom: {secretKeyRef: {name: app-secrets, key: DB_USER}}\n"), /flow-style/);
});

test("scanManifest names each document by kind and metadata.name", () => {
  const scanned = scanManifest(`${deployment("api", envFrom)}---\n${deployment("worker", keyRef("DB_USER"))}`);
  assert.deepEqual(scanned.map((s) => `${s.kind}/${s.name}`), ["Deployment/api", "Deployment/worker"]);
});

test("a clean setup has no problems", () => {
  assert.deepEqual(check([{ file: "api.yaml", text: deployment("api", envFrom) }, { file: "pg.yaml", text: deployment("postgres", keyRef("DB_USER")) }]), []);
});

test("a real value in the template is reported", () => {
  const found = problems({ templateText: template.replace("DB_USER: REPLACE_ME", "DB_USER: admin"), configMapText: configMap, manifests: [] });
  assert.deepEqual(found, ["template key DB_USER holds a value other than REPLACE_ME"]);
});

test("a data: section in the template is reported", () => {
  const found = problems({ templateText: `${template}data:\n  DB_USER: YWRtaW4=\n`, configMapText: configMap, manifests: [] });
  assert.ok(found.some((l) => l.includes("data: section")), found.join("\n"));
});

test("a key a manifest reads that the template lacks is reported", () => {
  assert.deepEqual(check([{ file: "pg.yaml", text: deployment("postgres", keyRef("DB_PASS")) }]), [
    "pg.yaml: Deployment/postgres reads DB_PASS, which the template does not define",
  ]);
});

test("the storage keys reach api and worker only, whole or by key (SEC-2)", () => {
  const job = { file: "job.yaml", text: deployment("migrate", envFrom) };
  assert.match(check([job])[0], /Deployment\/migrate takes every key of app-secrets \(envFrom\)/);
  const reader = { file: "web.yaml", text: deployment("web", keyRef("SPACES_KEY")) };
  assert.deepEqual(check([reader]), ["web.yaml: Deployment/web reads SPACES_KEY; the storage keys belong to api and worker only (SEC-2)"]);
});

test("a Secret object among the manifests is reported", () => {
  const found = check([{ file: "k8s/base/secrets.yaml", text: template }]);
  assert.deepEqual(found, ["k8s/base/secrets.yaml: contains a Secret object; only the template may"]);
});

// Valid YAML that an earlier version of the checker let through (security review, 11 November)
test("template bypasses: quoted key, flow-style data:, duplicate key, second Secret document", () => {
  const flagged = (text) => problems({ templateText: text, configMapText: configMap, manifests: [] });
  assert.ok(flagged(template.replace("  DB_USER: REPLACE_ME", '  "DB_USER": hunter2')).some((l) => /DB_USER holds a value/.test(l)));
  assert.ok(flagged(`${template}data: {DB_USER: YWRtaW4=}\n`).some((l) => /data: section/.test(l)));
  assert.ok(flagged(`${template}data: # note\n  A: YQ==\n`).some((l) => /data: section/.test(l)));
  assert.ok(flagged(template.replace("  SPACES_KEY: 'REPLACE_ME'", "  DB_USER: real\n  SPACES_KEY: REPLACE_ME")).some((l) => /DB_USER appears twice/.test(l)));
  assert.ok(flagged(`${template}---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: other\nstringData:\n  X: real\n`).some((l) => /more than one Secret/.test(l)));
});

test("consumer bypasses: comment after ---, secretRef with a comment, quoted secretName, projected volume, quoted kind", () => {
  const web = (body) => [{ file: "w.yaml", text: `kind: Deployment\nmetadata:\n  name: web\nspec:\n${body}` }];
  const ref = (body) => check(web(body)).join("\n");
  assert.match(ref("          envFrom:\n            - secretRef: # all\n                name: app-secrets\n"), /Deployment\/web takes every key/);
  assert.match(ref("      volumes:\n        - name: v\n          secret:\n            secretName: \"app-secrets\" # mount\n"), /takes every key/);
  assert.match(ref("      volumes:\n        - name: v\n          projected:\n            sources:\n              - secret:\n                  name: app-secrets\n"), /takes every key/);
  assert.throws(() => ref('          x: {"secretRef": {name: app-secrets}}\n'), /flow-style/);
  const merged = `kind: Deployment\nmetadata:\n  name: api\n--- # next\nkind: Job\nmetadata:\n  name: migrate\nspec:\n          envFrom:\n            - secretRef:\n                name: app-secrets\n`;
  assert.match(check([{ file: "m.yaml", text: merged }]).join("\n"), /Job\/migrate takes every key/);
  assert.deepEqual(check([{ file: "s.yaml", text: 'kind: "Secret" # x\nmetadata:\n  name: z\n' }]), ["s.yaml: contains a Secret object; only the template may"]);
  assert.match(check([{ file: "nokind.yaml", text: "valuesFrom:\n  secretKeyRef:\n    name: app-secrets\n    key: NOPE\n" }]).join("\n"), /reads NOPE/);
});

test("a labels: name before metadata.name does not borrow the api allowance", () => {
  const text = "kind: Job\nmetadata:\n  labels:\n    name: api\n  name: migrate\n          envFrom:\n            - secretRef:\n                name: app-secrets\n";
  assert.match(check([{ file: "j.yaml", text }]).join("\n"), /Job\/migrate takes every key/);
});

test("a literal value on a secret-looking env var, and a secretGenerator, are reported", () => {
  const env = "kind: Deployment\nmetadata:\n  name: api\nspec:\n          env:\n            - name: JWT_SECRET\n              value: hunter2\n";
  assert.match(check([{ file: "api.yaml", text: env }]).join("\n"), /sets JWT_SECRET to a literal value/);
  assert.match(check([{ file: "kustomization.yaml", text: "secretGenerator:\n  - name: x\n    literals:\n      - A=b\n" }]).join("\n"), /secretGenerator/);
});

test("a key in both the ConfigMap and the Secret is reported", () => {
  const found = problems({ templateText: template, configMapText: "data:\n  DB_USER: x\n", manifests: [] });
  assert.match(found[0], /DB_USER is in both the ConfigMap and the Secret/);
});

// The repository itself ---------------------------------------------------------------

const yamlUnderK8s = () =>
  readdirSync(join(root, "k8s"), { recursive: true })
    .filter((f) => /\.ya?ml$/.test(f) && f.replaceAll("\\", "/") !== "base/secrets.example.yaml")
    .map((f) => ({ file: `k8s/${f.replaceAll("\\", "/")}`, text: readFileSync(join(root, "k8s", f), "utf8") }));

test("k8s/base/secrets.example.yaml and every manifest that uses it pass the checks", () => {
  const found = problems({
    templateText: read("k8s/base/secrets.example.yaml"),
    configMapText: read("k8s/base/configmap.yaml"),
    manifests: yamlUnderK8s(),
  });
  assert.deepEqual(found, []);
});

test("Git tracks the template and no filled-in copy; the filled-in copy is ignored", () => {
  const tracked = git("ls-files", "k8s").split("\n");
  assert.ok(tracked.includes("k8s/base/secrets.example.yaml"));
  assert.deepEqual(tracked.filter((f) => /secret/i.test(f) && f !== "k8s/base/secrets.example.yaml"), []);
  for (const copy of ["k8s/base/secrets.yaml", "k8s/doks/secrets.yaml", "k8s/secret.yaml"]) {
    assert.doesNotThrow(() => git("check-ignore", "-q", copy), `${copy} is not git-ignored`);
  }
});

test("no tracked document tells the reader to apply a filled-in secrets.yaml", () => {
  const docs = git("ls-files", "*.md").split("\n").filter((f) => !f.startsWith("docs/BUILD_LOG"));
  const offenders = docs.filter((f) => /kubectl apply -f \S*secrets\.yaml/.test(read(f)));
  assert.deepEqual(offenders, []);
});

test("no tracked file under k8s/ or scripts/ other than the template defines a Secret object", () => {
  const offenders = git("ls-files", "k8s", "scripts")
    .split("\n")
    .filter((f) => f !== "k8s/base/secrets.example.yaml" && /\.ya?ml$/.test(f))
    .filter((f) => /^kind:\s*["']?Secret["']?\s*(#.*)?$/m.test(read(f)));
  assert.deepEqual(offenders.map((f) => relative(root, join(root, f))), []);
});

test("no tracked text file holds the shape of a real token or private key", () => {
  const shapes = [/dop_v1_[a-f0-9]{32,}/, /\bDO00[A-Z0-9]{16}\b/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bghp_[A-Za-z0-9]{36}\b/];
  const text = git("ls-files").split("\n").filter((f) => !/\.(png|jpe?g|gif|svg|pdf|ico|woff2?|lock)$|package-lock\.json$/.test(f));
  const hits = text.filter((f) => shapes.some((s) => s.test(read(f))));
  assert.deepEqual(hits, []);
});
