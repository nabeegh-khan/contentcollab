// Drives scripts/cluster-up.sh through stub doctl, kubectl, helm, curl, gh,
// git and sleep (#54, docs/ARCHITECTURE.md D13). Nothing reaches
// DigitalOcean, a cluster or the network: each stub appends its arguments to
// calls.log and answers from STUB_* variables. Run: node --test scripts/
// (BASH_BIN=path-to-bash on Windows, where `bash` may resolve to WSL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'cluster-up.sh');
const BASH = process.env.BASH_BIN || 'bash';

// Bash splits PATH at the colon of a drive letter (C:\...), which would let
// the real tool run instead of the stub; /c/... has no colon
const posix = (p) =>
  process.platform === 'win32'
    ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
    : p;

const STUB = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'testdata', 'cluster-up-stub.sh'), 'utf8');

// Refuses to start unless doctl resolves to the stub
const GUARD = `export PATH="$STUB_DIR:/usr/bin:/bin"
[ "$(command -v doctl)" = "$STUB_DIR/doctl" ] || { echo "stub guard: doctl is $(command -v doctl)"; exit 99; }
exec bash "$0"`;

function bringUp(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cluster-up-'));
  try {
    for (const tool of ['doctl', 'kubectl', 'helm', 'curl', 'gh', 'git', 'sleep']) {
      writeFileSync(join(dir, tool), STUB);
      chmodSync(join(dir, tool), 0o755);
    }
    writeFileSync(join(dir, 'app.yaml'), 'kind: Secret\n');
    writeFileSync(join(dir, 'calls.log'), '');
    const stubDir = posix(dir);
    const r = spawnSync(BASH, ['-c', GUARD, posix(script)], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        STUB_DIR: stubDir,
        HOME: stubDir,
        KUBECONFIG: `${stubDir}/kubeconfig`,
        SECRETS_FILE: `${stubDir}/app.yaml`,
        LETSENCRYPT_EMAIL: 'ops@example.org',
        IMAGE_TAG: 'abc123',
        DATADOG_API_KEY: '',
        CLUSTER_NAME: 'contentcollab',
        REGION: 'tor1',
        NODE_COUNT: '2',
        DRY_RUN: '0',
        STUB_CLUSTER: 'contentcollab 1.36.5-do.3',
        STUB_CM_INSTALLED: 'v1.21.3',
        STUB_GW_ADDR: '203.0.113.10',
        STUB_DNS_IP: '203.0.113.10',
        STUB_GH_NAMES: 'DIGITALOCEAN_ACCESS_TOKEN',
        ...env,
      },
    });
    assert.notEqual(r.status, 99, r.stdout); // stub guard tripped
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Calls that change DigitalOcean or the cluster
const changes = (calls) =>
  calls.filter((c) =>
    /^doctl kubernetes cluster (create|delete)|^helm (upgrade|install|uninstall)|^kubectl .*\b(apply|delete|patch|rollout restart)\b/.test(c),
  );
const certManagerVersions = (calls) =>
  calls
    .filter((c) => /^helm upgrade --install cert-manager /.test(c))
    .map((c) => c.match(/--version (\S+)/)[1]);

test('stops before any call when LETSENCRYPT_EMAIL is missing', () => {
  const r = bringUp({ LETSENCRYPT_EMAIL: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /LETSENCRYPT_EMAIL/);
  assert.deepEqual(r.calls, []);
});

test('rejects an address that is not an email (and an & that sed would expand)', () => {
  for (const email of ['not-an-email', 'ops&team@example.org']) {
    const r = bringUp({ LETSENCRYPT_EMAIL: email });
    assert.notEqual(r.code, 0, email);
    assert.match(r.out, /LETSENCRYPT_EMAIL/, email);
    assert.deepEqual(r.calls, [], email);
  }
});

test('rejects a NODE_COUNT that is not a positive number before any call', () => {
  const r = bringUp({ NODE_COUNT: 'two' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /NODE_COUNT/);
  assert.deepEqual(r.calls, []);
});

test('never creates a cluster when doctl is not signed in', () => {
  const r = bringUp({ STUB_AUTH: '0', STUB_CLUSTER: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /doctl auth init/);
  assert.equal(r.calls.filter((c) => / cluster create /.test(c)).length, 0);
});

test('creates a missing cluster at the newest 1.36 slug DOKS offers', () => {
  const r = bringUp({ STUB_CLUSTER: '', STUB_CM_INSTALLED: '' });
  assert.equal(r.code, 0, r.out);
  const create = r.calls.filter((c) => /^doctl kubernetes cluster create /.test(c));
  assert.equal(create.length, 1);
  assert.match(create[0], /--version 1\.36\.10-do\.1\b/); // 1.36.10 sorts above 1.36.5
  assert.deepEqual(certManagerVersions(r.calls), ['v1.21.3']); // fresh: straight to the pin
});

test('DRY_RUN=1 changes nothing and prints each change it would make', () => {
  const r = bringUp({ DRY_RUN: '1', STUB_CLUSTER: '', STUB_CM_INSTALLED: '' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(changes(r.calls), []);
  assert.equal(r.calls.filter((c) => /kubeconfig save/.test(c)).length, 0);
  assert.match(r.out, /DRY-RUN: doctl kubernetes cluster create contentcollab/);
  assert.match(r.out, /DRY-RUN: helm upgrade --install cert-manager/);
  assert.match(r.out, /DRY-RUN: kubectl apply/);
});

test('DRY_RUN=1 on the running cluster reads its state and still changes nothing', () => {
  const r = bringUp({ DRY_RUN: '1', STUB_CLUSTER: 'contentcollab 1.37.0-do.2', STUB_CM_INSTALLED: 'v1.19.2' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(changes(r.calls), []);
  assert.ok(r.calls.some((c) => /^helm list -n cert-manager/.test(c)));
  assert.match(r.out, /DRY-RUN: helm upgrade --install cert-manager .*--version v1\.20\.5/);
  assert.match(r.out, /DRY-RUN: helm upgrade --install cert-manager .*--version v1\.21\.3/);
  assert.equal(r.calls.filter((c) => /wait --for=condition=Ready/.test(c)).length, 0);
});

test('re-run on the running 1.37 cluster: no create, cert-manager one minor at a time', () => {
  const r = bringUp({ STUB_CLUSTER: 'contentcollab 1.37.0-do.2', STUB_CM_INSTALLED: 'v1.19.2' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.filter((c) => / cluster create /.test(c)).length, 0);
  assert.deepEqual(certManagerVersions(r.calls), ['v1.20.5', 'v1.21.3']);
  const steps = r.calls.filter((c) => /^helm upgrade --install cert-manager /.test(c));
  assert.match(steps[0], /config\.enableGatewayAPI=true/); // 1.20 has no gatewayAPI.enabled
  assert.match(steps[1], /config\.gatewayAPI\.enabled=true/);
  assert.match(r.out, /1\.37\.0-do\.2.*1\.36/); // warns: above cert-manager's range
});

test('re-run at the pinned versions upgrades each release in place once', () => {
  const r = bringUp({});
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(certManagerVersions(r.calls), ['v1.21.3']);
  const ngf = r.calls.filter((c) => /^helm upgrade --install ngf /.test(c));
  assert.equal(ngf.length, 1);
  assert.match(ngf[0], /--version 2\.8\.1\b/);
  assert.equal(r.calls.filter((c) => / cluster create /.test(c)).length, 0);
});

test('refuses a cert-manager jump with no step for the minor in between', () => {
  const r = bringUp({ STUB_CM_INSTALLED: 'v1.18.6' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /v1\.18\.6/);
  assert.deepEqual(certManagerVersions(r.calls), []);
});

test('DNS not pointed at the Gateway yet: prints the A record and exits 0 without waiting', () => {
  const r = bringUp({ STUB_DNS_IP: '198.51.100.7' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /A record contentcollab\.app\b.*203\.0\.113\.10/);
  assert.equal(r.calls.filter((c) => /wait --for=condition=Ready/.test(c)).length, 0);
});

test('certificate not issued once DNS points: exits 1 and shows cert-manager status', () => {
  const r = bringUp({ STUB_CERT_WAIT_RC: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /HTTP-01/);
  assert.ok(r.calls.some((c) => /get certificate,certificaterequest,order,challenge/.test(c)));
});

test('certificate issued: reports it and exits 0', () => {
  const r = bringUp({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /[Cc]ertificate ready/);
});

test('CI token missing: prints the gh command that sets it, and still exits 0', () => {
  for (const names of ['PROJECT_TOKEN', 'DIGITALOCEAN_ACCESS_TOKEN_OLD']) {
    const r = bringUp({ STUB_GH_NAMES: names });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /gh secret set DIGITALOCEAN_ACCESS_TOKEN/, names);
  }
});

test('a cluster with a similar name is not this cluster', () => {
  const r = bringUp({ STUB_CLUSTER: 'contentcollab-old 1.36.5-do.3', STUB_CM_INSTALLED: '' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.filter((c) => /^doctl kubernetes cluster create contentcollab /.test(c)).length, 1);
});

test('certificate never created by cert-manager: says so, not "not issued"', () => {
  const r = bringUp({ STUB_CERT_CREATE_RC: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cert-manager did not create certificate\/contentcollab-tls/);
  assert.doesNotMatch(r.out, /not issued within/);
});

test('waits for both the api and the worker rollouts', () => {
  const r = bringUp({});
  assert.equal(r.code, 0, r.out);
  for (const d of ['api', 'worker']) {
    assert.ok(r.calls.some((c) => c.includes(`rollout status deployment/${d}`)), d);
  }
});

test('DRY_RUN=1 with a Datadog key changes nothing either', () => {
  const r = bringUp({ DRY_RUN: '1', DATADOG_API_KEY: 'abc123', STUB_CLUSTER: 'contentcollab 1.37.0-do.2' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(changes(r.calls), []);
  assert.match(r.out, /DRY-RUN: helm upgrade --install datadog-agent/);
});
