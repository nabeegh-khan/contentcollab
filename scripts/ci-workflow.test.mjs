// Pins the wiring of .github/workflows/ci.yml that the script tests cannot see:
// a later edit that turns a gate into `true`, moves it after Jest or pushes the
// web image must fail here (INF-5, DB-9, TST-5; docs/BUILD_LOG.md, 11 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scriptsDir } from './ci-test-helper.mjs';

const ci = readFileSync(join(scriptsDir, '..', '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
// text of one top-level job: from "  name:" to the next "  other:" at the same depth
const job = (name) => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name} not found`);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

test('test job: migration check runs before Jest, with every PG variable', () => {
  const t = job('test');
  const mig = t.indexOf('bash ../scripts/ci-migrate-check.sh');
  assert.ok(mig > 0, 'migration step missing');
  assert.ok(t.indexOf('run: npm test') > mig, 'Jest must come after the migration check');
  for (const v of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) assert.ok(t.includes(`${v}: ${'$'}{{ env.DB_`), `${v} missing`);
});

test('k8s job: cloud manifests are rendered, and the namespace check covers them without hiding yq errors', () => {
  const k = job('k8s');
  assert.match(k, /run: bash scripts\/ci-k8s-cloud\.sh/);
  assert.match(k, /for overlay in minikube doks infra migrate-job; do/);
  assert.doesNotMatch(k, /yq [^\n]*\|\s*grep/, 'piping yq into grep with || true hides a yq failure');
});

test('web job: skips on a missing Dockerfile, builds on a present one, never pushes', () => {
  const w = job('web');
  assert.match(w, /hashFiles\('web\/Dockerfile'\) == ''/);
  assert.equal((w.match(/hashFiles\('web\/Dockerfile'\) != ''/g) || []).length, 2);
  assert.match(w, /push: false/);
  assert.doesNotMatch(w, /push: true/);
  assert.match(w, /scope=web/);
});
