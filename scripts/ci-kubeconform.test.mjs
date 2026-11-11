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

test('validates once per version when KUBE_VERSION lists several', () => {
  const r = withFiles(['a.yaml'], { KUBE_VERSION: '1.36.0 1.37.0' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[0], /-kubernetes-version 1\.36\.0 /);
  assert.match(r.calls[1], /-kubernetes-version 1\.37\.0 /);
});

test('fails when any listed version rejects a manifest, naming that version', () => {
  const body = 'case "$*" in *1.37.0*) echo "a.yaml failed validation"; exit 1;; esac; exit 0';
  const r = withFiles(['a.yaml'], { KUBE_VERSION: '1.36.0 1.37.0', KC_BODY: body });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Kubernetes 1\.37\.0/);
});

test('rejects a version that is not x.y.z before calling kubeconform', () => {
  const r = withFiles(['a.yaml'], { KUBE_VERSION: '1.36.0 latest' });
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.calls, []);
});

test('ci.yml has no kubeconform call of its own: versions set once, the planned 1.36 and the running 1.37', () => {
  const ci = readFileSync(join(scriptsDir, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /-kubernetes-version/, 'a hard-coded version bypasses KUBE_VERSION');
  assert.doesNotMatch(ci, /^\s*kubeconform /m, 'call scripts/ci-kubeconform.sh instead');
  assert.match(ci, /^\s+KUBE_VERSION: "1\.36\.\d+ 1\.37\.\d+"\s*(#.*)?$/m);
});
