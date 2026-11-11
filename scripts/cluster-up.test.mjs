// Drives scripts/cluster-up.sh through stub doctl, kubectl, helm, curl, gh,
// git and sleep (#54, docs/ARCHITECTURE.md D13). Nothing reaches
// DigitalOcean, a cluster or the network: each stub appends its arguments to
// calls.log and answers from STUB_* variables. Run: node --test scripts/
// (BASH_BIN=path-to-bash on Windows, where `bash` may resolve to WSL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const tools = ['doctl', 'kubectl', 'helm', 'curl', 'gh', 'git', 'sleep'];
    for (const tool of tools.filter((t) => t !== env.STUB_HIDE)) {
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
    const appliedPath = join(dir, 'applied.yaml');
    const applied = existsSync(appliedPath) ? readFileSync(appliedPath, 'utf8') : '';
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls, applied };
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

// Second review round (30 mutants on d74a04d)

test('IMAGE_TAG defaults to the newest commit touching api, worker, k8s or deploy.yml', () => {
  const r = bringUp({ IMAGE_TAG: '', STUB_GIT_SHA: 'f00dfeed' });
  assert.equal(r.code, 0, r.out);
  const log = r.calls.find((c) => /^git log /.test(c));
  assert.ok(log, 'git log called');
  for (const path of ['api', 'worker', 'k8s', '.github/workflows/deploy.yml']) {
    assert.ok(log.split(' ').includes(path), path); // deploy.yml also builds on worker/**
  }
  assert.match(r.applied, /contentcollab-api:f00dfeed/);
});

test('the applied app uses IMAGE_TAG, never :latest', () => {
  const r = bringUp({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.applied, /contentcollab-api:abc123/);
  assert.doesNotMatch(r.applied, /contentcollab-api:latest/);
});

test('an image missing from the registry stops the run before the app is applied', () => {
  const r = bringUp({ STUB_MANIFEST_CODE: '404' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no image .*abc123/);
  assert.doesNotMatch(r.applied, /contentcollab-api/);
});

test('a failed helm list stops the run instead of reading as "not installed"', () => {
  const r = bringUp({ STUB_HELM_LIST_RC: '1', STUB_CM_INSTALLED: 'v1.19.2' });
  assert.notEqual(r.code, 0);
  assert.deepEqual(certManagerVersions(r.calls), []);
  assert.match(r.out, /helm list/);
});

test('helm list includes releases stuck in pending or failed states', () => {
  const r = bringUp({});
  assert.ok(r.calls.some((c) => /^helm list .*(--all|-a)\b/.test(c)));
});

test('a failed cluster list stops the run with no create', () => {
  const r = bringUp({ STUB_CLUSTER_LIST_RC: '1', STUB_CLUSTER: '' });
  assert.notEqual(r.code, 0);
  assert.equal(r.calls.filter((c) => / cluster create /.test(c)).length, 0);
});

test('cert-manager newer than the pin (even a patch) is refused, never downgraded', () => {
  for (const v of ['v1.22.0', 'v1.21.5']) {
    const r = bringUp({ STUB_CM_INSTALLED: v });
    assert.notEqual(r.code, 0, v);
    assert.match(r.out, /newer than the pinned/, v);
    assert.deepEqual(certManagerVersions(r.calls), [], v);
  }
});

test('rejects bad DRY_RUN, REGION, NODE_SIZE, IMAGE_TAG and a missing app file before any call', () => {
  const cases = [
    [{ DRY_RUN: 'yes' }, /DRY_RUN/],
    [{ REGION: 'Toronto' }, /REGION/],
    [{ NODE_SIZE: 's-2vcpu-2gb;count=9' }, /NODE_SIZE/],
    [{ IMAGE_TAG: 'abc#123' }, /IMAGE_TAG/],
    [{ SECRETS_FILE: '/nonexistent/app.yaml' }, /missing \/nonexistent\/app\.yaml/],
  ];
  for (const [env, msg] of cases) {
    const r = bringUp(env);
    assert.notEqual(r.code, 0, JSON.stringify(env));
    assert.match(r.out, msg, JSON.stringify(env));
    assert.deepEqual(r.calls, [], JSON.stringify(env));
  }
});

test('a missing tool stops the run before any change', () => {
  // PATH holds only the stubs and /usr/bin:/bin; hide helm
  const r = bringUp({ STUB_HIDE: 'helm' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /missing tool: helm/);
  assert.deepEqual(changes(r.calls), []);
});

test('installs pin the CRD ref, switch off telemetry and wait for each step', () => {
  const r = bringUp({ STUB_CM_INSTALLED: 'v1.19.2' });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.calls.some((c) => /kustomize .*standard\?ref=v2\.8\.1\b/.test(c)));
  assert.ok(r.calls.some((c) => /^helm upgrade --install ngf .*productTelemetry\.enable=false/.test(c)));
  for (const c of r.calls.filter((c) => /^helm upgrade --install cert-manager /.test(c))) {
    assert.match(c, /--wait\b/);
  }
  for (const d of ['cert-manager', 'cert-manager-cainjector', 'cert-manager-webhook']) {
    assert.ok(r.calls.some((c) => c.includes(`-n cert-manager rollout status deployment/${d}`)), d);
  }
  assert.ok(r.calls.some((c) => /wait --for=create certificate\/contentcollab-tls/.test(c)));
});

test('Datadog with a key: checks key and site, installs, restarts an installed agent', () => {
  const bad = [
    [{ DATADOG_API_KEY: 'abc-123' }, /DATADOG_API_KEY has characters/],
    [{ DATADOG_API_KEY: 'abc123', DATADOG_SITE: 'evil.example' }, /not a Datadog site/],
  ];
  for (const [env, msg] of bad) {
    const r = bringUp(env);
    assert.notEqual(r.code, 0, JSON.stringify(env));
    assert.match(r.out, msg);
    assert.equal(r.calls.filter((c) => /datadog-agent/.test(c)).length, 0);
  }
  const ok = bringUp({ DATADOG_API_KEY: 'abc123', STUB_DD_INSTALLED: '1' });
  assert.equal(ok.code, 0, ok.out);
  assert.ok(ok.calls.some((c) => /^helm upgrade --install datadog-agent .*--version 3\.269\.1/.test(c)));
  assert.ok(ok.calls.some((c) => /rollout restart daemonset\/datadog-agent/.test(c)));
  assert.match(ok.applied, /name: datadog-secret/);
  const dry = bringUp({ DRY_RUN: '1', DATADOG_API_KEY: 'abc123', STUB_DD_INSTALLED: '1' });
  assert.equal(dry.code, 0, dry.out);
  assert.deepEqual(changes(dry.calls), []);
  assert.match(dry.out, /DRY-RUN: kubectl -n datadog rollout restart/);
});
