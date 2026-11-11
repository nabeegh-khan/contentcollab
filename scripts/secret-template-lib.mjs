// Reads the Kubernetes manifests as text, no YAML library: the files are small and flat, and
// the checks in secret-template.test.mjs only need to know which Secret keys exist and who
// consumes them (SEC-1, SEC-2, SEC-10). Flow-style references are refused rather than missed.

export const PLACEHOLDER = "REPLACE_ME";

const lines = (text) => text.split(/\r?\n/);
const indentOf = (line) => line.length - line.trimStart().length;
// A YAML scalar on one line: quotes removed, a trailing `# comment` dropped (a # inside quotes stays)
const scalar = (raw) => {
  const value = raw.trim();
  const quoted = value.match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
  return quoted ? quoted[2] : value.replace(/\s+#.*$/, "");
};
const isBlankOrComment = (line) => line.trim() === "" || line.trim().startsWith("#");

/** Entries of a flat top-level mapping such as `stringData:` or `data:`; null when absent. */
export function flatSection(text, section) {
  const all = lines(text);
  const start = all.findIndex((l) => l.trimEnd() === `${section}:`);
  if (start === -1) return null;
  const entries = {};
  for (const line of all.slice(start + 1)) {
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) === 0) break;
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/);
    if (match) entries[match[1]] = scalar(match[2]);
  }
  return entries;
}

/** Splits a multi-document file; each document keeps its kind and metadata.name. */
export function documents(text) {
  return text
    .split(/^---\s*$/m)
    .map((body) => {
      const kind = body.match(/^kind:\s*(\S+)/m)?.[1];
      const name = body.match(/^metadata:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+name:\s*(\S+)/m)?.[1];
      return { kind, name, body };
    })
    .filter((d) => d.kind);
}

/** The block of lines indented deeper than the line at `index`. */
function blockAfter(all, index) {
  const base = indentOf(all[index]);
  const block = [];
  for (const line of all.slice(index + 1)) {
    if (!isBlankOrComment(line) && indentOf(line) <= base) break;
    block.push(line);
  }
  return block;
}

const field = (block, key) => {
  const hit = block.map((l) => l.trim().match(new RegExp(`^${key}:\\s*(.+)$`))).find(Boolean);
  return hit ? scalar(hit[1]) : undefined;
};

/** Per-key and whole-Secret references in one document. */
export function secretReferences(body) {
  const all = lines(body);
  const keyRefs = [];
  const wholeRefs = [];
  all.forEach((line, i) => {
    if (/(secretKeyRef|secretRef):\s*\{/.test(line)) {
      throw new Error(`flow-style reference not supported, use a block: ${line.trim()}`);
    }
    if (/^\s*(- )?secretKeyRef:\s*$/.test(line)) {
      const block = blockAfter(all, i);
      keyRefs.push({ secret: field(block, "name"), key: field(block, "key") });
    } else if (/^\s*(- )?secretRef:\s*$/.test(line)) {
      wholeRefs.push({ secret: field(blockAfter(all, i), "name"), via: "envFrom" });
    } else if (/^\s*secretName:\s*\S+/.test(line)) {
      wholeRefs.push({ secret: line.trim().split(/:\s*/)[1], via: "volume" });
    }
  });
  return { keyRefs, wholeRefs };
}

/** Every workload-or-other object in a manifest file with the Secret references it makes. */
export function scanManifest(text) {
  return documents(text).map(({ kind, name, body }) => ({ kind, name, ...secretReferences(body) }));
}

const SECRET = "app-secrets";
// SEC-2: the whole Secret (every key) goes to these two workloads and to nothing else
export const WHOLE_SECRET_CONSUMERS = ["Deployment/api", "Deployment/worker"];
const SPACES_KEYS = /^SPACES_/;

/**
 * What is wrong with the Secret template and with the manifests that use it, as readable lines.
 * `manifests` is [{ file, text }] for every YAML file under k8s/ except the template itself.
 */
export function problems({ templateText, manifests, configMapText }) {
  const found = [];
  const template = documents(templateText).find((d) => d.kind === "Secret");
  if (!template || template.name !== SECRET) return [`the template is not the ${SECRET} Secret`];

  if (flatSection(templateText, "data")) {
    found.push("the template has a data: section; base64 hides nothing (SEC-10), use stringData with placeholders");
  }
  const entries = flatSection(templateText, "stringData") ?? {};
  if (Object.keys(entries).length === 0) found.push("the template has no stringData keys");
  for (const [key, value] of Object.entries(entries)) {
    if (value !== PLACEHOLDER) found.push(`template key ${key} holds a value other than ${PLACEHOLDER}`);
  }

  const configKeys = Object.keys(flatSection(configMapText, "data") ?? {});
  for (const key of configKeys.filter((k) => k in entries)) {
    found.push(`${key} is in both the ConfigMap and the Secret, so which one wins is an accident`);
  }

  for (const { file, text } of manifests) {
    for (const { kind, name, keyRefs, wholeRefs } of scanManifest(text)) {
      const who = `${kind}/${name}`;
      if (kind === "Secret") found.push(`${file}: contains a Secret object; only the template may`);
      for (const { key } of keyRefs.filter((r) => r.secret === SECRET)) {
        if (!(key in entries)) found.push(`${file}: ${who} reads ${key}, which the template does not define`);
        if (SPACES_KEYS.test(key) && !WHOLE_SECRET_CONSUMERS.includes(who)) {
          found.push(`${file}: ${who} reads ${key}; the storage keys belong to api and worker only (SEC-2)`);
        }
      }
      for (const { via } of wholeRefs.filter((r) => r.secret === SECRET)) {
        if (!WHOLE_SECRET_CONSUMERS.includes(who)) {
          found.push(`${file}: ${who} takes every key of ${SECRET} (${via}); SEC-2 allows that for api and worker only, read the keys it needs one by one with secretKeyRef`);
        }
      }
    }
  }
  return found;
}
