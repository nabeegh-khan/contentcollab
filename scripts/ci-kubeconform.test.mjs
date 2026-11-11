// Tests for ci-kubeconform.sh: the one place CI says which Kubernetes version
// manifests are validated against (INF-5, TST-5; docs/BUILD_LOG.md, 11 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCi, scriptsDir } from './ci-test-helper.mjs';

// Runs the script with the manifests as its arguments and a stub kubeconform
const withFiles = (files, env = {}) =>
  runCi('ci-kubeconform.sh', {
    stubs: { kubeconform: env.KC_BODY ?? 'exit 0' },
    env,
    args: files,
  });

test('stops before validating when KUBE_VERSION is not set', () => {
  const r = withFiles(['a.yaml'], { KUBE_VERSION: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /KUBE_VERSION/);
  assert.deepEqual(r.calls, []);
});

test('stops when no file is given', () => {
  const r = withFiles([], { KUBE_VERSION: '1.36.0' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no manifest/i);
  assert.deepEqual(r.calls, []);
});

test('validates strictly at KUBE_VERSION with the default and CRD schemas', () => {
  const r = withFiles(['a.yaml', 'b.yaml'], { KUBE_VERSION: '1.36.0' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 1);
  const call = r.calls[0];
  assert.match(call, /^kubeconform /);
  assert.match(call, / -strict /);
  assert.match(call, /-kubernetes-version 1\.36\.0 /);
  assert.match(call, /-schema-location default /);
  assert.match(call, /datreeio\/CRDs-catalog\/main\/\{\{\.Group\}\}\/\{\{\.ResourceKind\}\}_\{\{\.ResourceAPIVersion\}\}\.json/);
  assert.match(call, /a\.yaml b\.yaml$/);
});

test('fails when kubeconform rejects a manifest, and says which version it used', () => {
  const r = withFiles(['a.yaml'], { KUBE_VERSION: '1.36.0', KC_BODY: 'echo "a.yaml - Foo failed validation"; exit 1' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /failed validation/);
  assert.match(r.out, /1\.36\.0/);
});

test('ci.yml has no kubeconform call of its own: the version is set once, at a supported 1.36 patch', () => {
  const ci = readFileSync(join(scriptsDir, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /-kubernetes-version/, 'a hard-coded version bypasses KUBE_VERSION');
  assert.doesNotMatch(ci, /^\s*kubeconform /m, 'call scripts/ci-kubeconform.sh instead');
  assert.match(ci, /^\s+KUBE_VERSION: "?1\.36\.\d+"?\s*(#.*)?$/m);
});
