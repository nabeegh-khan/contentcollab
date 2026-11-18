// Tests for ci-k8s-cloud.sh: CI renders the DOKS infra overlay and the
// migrate Job once they exist, and checks them like the two overlays (INF-5,
// TST-5; docs/BUILD_LOG.md, 11 Nov). kubectl and kubeconform are stubs;
// the stub kubectl prints a one-line manifest so the output file can be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCi } from './ci-test-helper.mjs';

const JOB = `apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate-__IMAGE_TAG__
  namespace: contentcollab
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: ghcr.io/example/api:__IMAGE_TAG__
`;

const INFRA = { 'k8s/doks/infra/kustomization.yaml': 'kind: Kustomization\n' };
const MIGRATE = { 'k8s/doks/migrate-job.yaml': JOB };

const run = (files, { kubectl = 'echo "kind: Namespace"', kubeconform = 'exit 0', env = {} } = {}) =>
  runCi('ci-k8s-cloud.sh', {
    stubs: { kubectl, kubeconform },
    files,
    env: { KUBE_VERSION: '1.36.0', ...env },
  });

test('does nothing while neither the infra overlay nor the migrate Job exists', () => {
  const r = run({});
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, []);
  assert.match(r.out, /skipped/);
});

test('renders the infra overlay with the load restrictor off, then validates the render', () => {
  const r = run(INFRA);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls[0], 'kubectl kustomize --load-restrictor=LoadRestrictionsNone k8s/doks/infra');
  assert.match(r.calls[1], /^kubeconform .*-kubernetes-version 1\.36\.0 .* .*infra\.yaml$/);
  assert.match(r.written['infra.yaml'], /kind: Namespace/);
});

test('fills the image tag placeholder before validating the migrate Job', () => {
  const r = run(MIGRATE);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0], /^kubeconform .*migrate-job\.yaml$/);
  assert.doesNotMatch(r.calls[0], /k8s\/doks\/migrate-job\.yaml/, 'validates the filled render, not the template');
  assert.doesNotMatch(r.written['migrate-job.yaml'], /__IMAGE_TAG__/);
  assert.match(r.written['migrate-job.yaml'], /name: db-migrate-ci$/m);
});

test('a placeholder the deploy does not fill fails the check', () => {
  const r = run({ 'k8s/doks/migrate-job.yaml': JOB.replace('example/api', '__REGISTRY__/api') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /__REGISTRY__/);
  assert.deepEqual(r.calls, []);
});

test('a placeholder with digits or an underscore-split name is caught too', () => {
  const r = run({ 'k8s/doks/migrate-job.yaml': JOB.replace('example/api', '__IMAGE_TAG2__/api') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /__IMAGE_TAG2__/);
});

test('an overlay that does not render fails before kubeconform runs', () => {
  const r = run(INFRA, { kubectl: 'echo "error: accumulating resources" >&2; exit 1' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /accumulating resources/);
  assert.ok(!r.calls.some((c) => c.startsWith('kubeconform')));
});

test('a manifest kubeconform rejects fails the check', () => {
  const r = run({ ...INFRA, ...MIGRATE }, { kubeconform: 'echo "rejected"; exit 1' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /rejected/);
});

test('stops when KUBE_VERSION is not set', () => {
  const r = run(INFRA, { env: { KUBE_VERSION: '' } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /KUBE_VERSION/);
});
