// Reads the Kubernetes manifests as text, no YAML library: the files are small and flat, and
// the checks in secret-template.test.mjs only need to know which Secret keys exist and who
// consumes them (SEC-1, SEC-2, SEC-10). It catches the common mistakes and the odd spellings
// of them that a review found (quoted keys, comments after markers, projected volumes); it is
// not a YAML parser, and anything it cannot read it refuses (flow style) rather than skips.

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
// `key:` that opens a block: nothing after the colon but an optional comment, anchor or tag
const OPENS_BLOCK = String.raw`:\s*(?:[&!]\S+\s*)?(?:#.*)?$`;

/** [[key, value], ...] of a flat top-level mapping such as `stringData:`, duplicates kept; null when absent. */
function sectionPairs(text, section) {
  const all = lines(text);
  const start = all.findIndex((l) => new RegExp(`^${section}${OPENS_BLOCK}`).test(l));
  if (start === -1) return null;
  const pairs = [];
  for (const line of all.slice(start + 1)) {
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) === 0) break;
    const match = line.trim().match(/^["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?:\s*(.*)$/);
    if (match) pairs.push([match[1], scalar(match[2])]);
  }
  return pairs;
}

/** Entries of a flat top-level mapping; null when the section is absent. */
export function flatSection(text, section) {
  const pairs = sectionPairs(text, section);
  return pairs && Object.fromEntries(pairs);
}

/** Splits a multi-document file; every document is kept, with its kind and metadata.name when it has them. */
export function documents(text) {
  return text
    .split(/^---.*$/m)
    .filter((body) => body.trim() !== "")
    .map((body) => {
      const kind = body.match(/^kind:\s*["']?([A-Za-z]+)["']?/m)?.[1];
      // metadata.name is indented exactly two spaces; a labels: name is deeper
      const name = body.match(/^metadata:[^\n]*\n(?:[ \t]+.*\n)*?[ ]{2}name:\s*["']?([^\s"'#]+)/m)?.[1];
      return { kind: kind ?? "(no kind)", name: name ?? "(no name)", body };
    });
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

const opener = (word) => new RegExp(`^\\s*(?:-\\s+)?["']?${word}["']?${OPENS_BLOCK}`);

/** Per-key and whole-Secret references in one document. */
export function secretReferences(body) {
  const all = lines(body);
  const keyRefs = [];
  const wholeRefs = [];
  all.forEach((line, i) => {
    if (/["']?(secretKeyRef|secretRef)["']?\s*:\s*\{/.test(line)) {
      throw new Error(`flow-style reference not supported, use a block: ${line.trim()}`);
    }
    if (opener("secretKeyRef").test(line)) {
      const block = blockAfter(all, i);
      keyRefs.push({ secret: field(block, "name"), key: field(block, "key") });
    } else if (opener("secretRef").test(line)) {
      wholeRefs.push({ secret: field(blockAfter(all, i), "name"), via: "envFrom" });
    } else if (opener("secret").test(line)) {
      // a projected volume source: `secret:` with a `name:`
      const name = field(blockAfter(all, i), "name");
      if (name) wholeRefs.push({ secret: name, via: "projected volume" });
    } else if (/^\s*secretName\s*:/.test(line)) {
      wholeRefs.push({ secret: scalar(line.split(/:(.*)/s)[1]), via: "volume" });
    }
  });
  return { keyRefs, wholeRefs };
}

/** `- name: X` followed by `value: Y` where X names a secret and Y is a literal. */
function literalSecrets(body) {
  const found = [];
  const all = lines(body);
  all.forEach((line, i) => {
    const name = line.trim().match(/^-\s+name:\s*["']?([A-Za-z0-9_]*(?:SECRET|PASSWORD|TOKEN|_KEY)[A-Za-z0-9_]*)["']?\s*$/i)?.[1];
    const value = all[i + 1]?.trim().match(/^value:\s*(.+)$/)?.[1];
    if (name && value && scalar(value) !== "") found.push(name);
  });
  return found;
}

/** Every object in a manifest file with the Secret references it makes. */
export function scanManifest(text) {
  return documents(text).map(({ kind, name, body }) => ({ kind, name, ...secretReferences(body), literals: literalSecrets(body) }));
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
  const secrets = documents(templateText).filter((d) => d.kind === "Secret");
  if (secrets.length === 0 || secrets[0].name !== SECRET) return [`the template is not the ${SECRET} Secret`];
  if (secrets.length > 1) found.push("the template has more than one Secret document");

  if (/^data\s*:/m.test(templateText)) {
    found.push("the template has a data: section; base64 hides nothing (SEC-10), use stringData with placeholders");
  }
  const pairs = sectionPairs(templateText, "stringData") ?? [];
  if (pairs.length === 0) found.push("the template has no stringData keys");
  const seen = new Set();
  for (const [key, value] of pairs) {
    if (seen.has(key)) found.push(`${key} appears twice in the template`);
    seen.add(key);
    if (value !== PLACEHOLDER) found.push(`template key ${key} holds a value other than ${PLACEHOLDER}`);
  }
  const entries = Object.fromEntries(pairs);

  const configKeys = Object.keys(flatSection(configMapText, "data") ?? {});
  for (const key of configKeys.filter((k) => k in entries)) {
    found.push(`${key} is in both the ConfigMap and the Secret, so which one wins is an accident`);
  }

  for (const { file, text } of manifests) {
    if (/^\s*secretGenerator\s*:/m.test(text)) found.push(`${file}: secretGenerator builds a Secret from literals or files in Git`);
    for (const { kind, name, keyRefs, wholeRefs, literals } of scanManifest(text)) {
      const who = `${kind}/${name}`;
      if (kind === "Secret") found.push(`${file}: contains a Secret object; only the template may`);
      for (const env of literals) found.push(`${file}: ${who} sets ${env} to a literal value; read it from the Secret`);
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
