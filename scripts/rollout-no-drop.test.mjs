// Drives scripts/rollout-no-drop.sh through a stub kubectl (#69): the verdict
// logic only, with no cluster. The real behaviour is the k3s before/after run
// in docs/BUILD_LOG.md. Run: node --test scripts/ (BASH_BIN=path-to-bash on
// Windows, where `bash` may resolve to WSL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'rollout-no-drop.sh');
const STUB = readFileSync(join(here, 'testdata', 'k6-kubectl-stub.sh'), 'utf8');
const BASH = process.env.BASH_BIN || 'bash';
// Bash splits PATH at a drive letter's colon (C:\...); /c/... has none
const posix = (p) =>
  process.platform === 'win32'
    ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
    : p;
// Refuses to start unless kubectl resolves to the stub
const GUARD = `export PATH="$STUB_DIR:/usr/bin:/bin"
[ "$(command -v kubectl)" = "$STUB_DIR/kubectl" ] || { echo "stub guard: kubectl is $(command -v kubectl)"; exit 99; }
exec bash "$0"`;

function rollout(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-'));
  try {
    for (const tool of ['kubectl', 'sleep']) {
      writeFileSync(join(dir, tool), STUB);
      chmodSync(join(dir, tool), 0o755);
    }
    writeFileSync(join(dir, 'calls.log'), '');
    const stubDir = posix(dir);
    const r = spawnSync(BASH, ['-c', GUARD, posix(script)], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, STUB_DIR: stubDir, KUBECONFIG: `${stubDir}/none`, WARMUP: '0', ...env },
    });
    assert.notEqual(r.status, 99, r.stdout);
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
    const appliedPath = join(dir, 'applied.yaml');
    const applied = existsSync(appliedPath) ? readFileSync(appliedPath, 'utf8') : '';
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls, applied };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no failed request and a new revision: passes', () => {
  const r = rollout({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS: no request failed/);
  assert.ok(r.calls.some((c) => /rollout restart deployment\/api/.test(c)));
});

test('any failed request fails the run and shows the failures', () => {
  const r = rollout({ STUB_FAILURES: '3' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL: 3 of 4500 requests failed/);
  assert.match(r.out, /^FAIL 2026-11-11T16:21:59\.662Z status=503/m);
});

test('no new revision after the restart: fails, never passes', () => {
  const r = rollout({ STUB_REV_OLD: '4', STUB_REV_NEW: '4' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no new revision/);
});

test('load that ended before the rollout finished: fails, never passes', () => {
  const r = rollout({ STUB_LOAD_ENDED_EARLY: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /load ended before the rollout finished/);
});

test('no requests sent: fails', () => {
  const r = rollout({ STUB_REQUESTS: '0' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no requests were sent/);
});

test('bad settings stop the run before any change', () => {
  for (const env of [{ RATE: 'fast' }, { DURATION: '2m' }, { WARMUP: '-1' }, { TARGET: 'http://x/"; rm -rf /' }]) {
    const r = rollout(env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.ok(!r.calls.some((c) => /rollout restart/.test(c)), JSON.stringify(env));
  }
});

// DOKS rework (#69): the default target, the undo action, a revision that is
// not a number, and nodes too full to add a load generator

test('default target is the API Service /metrics: no dependency checks in the way', () => {
  const r = rollout({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.applied, /value: "http:\/\/api\.contentcollab\.svc\.cluster\.local:3000\/metrics"/);
});

test('ACTION=undo rolls back under load and still needs a new revision', () => {
  const r = rollout({ ACTION: 'undo' });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.calls.some((c) => /rollout undo deployment\/api/.test(c)));
  assert.ok(!r.calls.some((c) => /rollout restart/.test(c)));
  const same = rollout({ ACTION: 'undo', STUB_REV_OLD: '5', STUB_REV_NEW: '5' });
  assert.equal(same.code, 1, same.out);
  assert.match(same.out, /no new revision/);
});

test('an unknown ACTION stops the run before any change', () => {
  const r = rollout({ ACTION: 'delete' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ACTION/);
  assert.ok(!r.calls.some((c) => /rollout|apply/.test(c)));
});

test('a revision that is not a number stops with a message, not a shell error', () => {
  const r = rollout({ STUB_REV_OLD: 'none', STUB_REV_NEW: 'none' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /revision/);
  assert.doesNotMatch(r.out, /integer expression expected/);
  // Stops before the load starts or anything restarts: bash's own wording for a
  // bad number differs between versions, this does not
  assert.ok(!r.calls.some((c) => /rollout restart|apply/.test(c)), r.calls.join('\n'));
});

test('nodes above the memory limit: refuses before starting the load or the restart', () => {
  for (const env of [{ STUB_NODE_MEM: '93' }, { STUB_NODE_MEM_B: '93' }]) {
    const r = rollout(env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.out, /memory/, JSON.stringify(env));
    assert.ok(!r.calls.some((c) => /rollout restart|apply/.test(c)), JSON.stringify(env));
  }
  const ok = rollout({ STUB_NODE_MEM: '85', MAX_NODE_MEMORY_PCT: '90' });
  assert.equal(ok.code, 0, ok.out);
});

// Second review round: the checks must fail closed (a pass has to be earned)

test('a RESULT line without a failure count is not a pass', () => {
  const r = rollout({ STUB_RESULT_MALFORMED: '1' });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /PASS/);
  assert.match(r.out, /RESULT/);
});

test('a kubectl error while reading the load Job is not read as "still running"', () => {
  const r = rollout({ STUB_JOB_ERR: '1' });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /PASS/);
  assert.match(r.out, /Unknown/);
});

test('a failed load Job stops the run and names the state', () => {
  const r = rollout({ STUB_JOB_FAILED: '1' });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /PASS/);
  assert.match(r.out, /Failed/);
});

test('a node whose memory is unknown is reported as not checked, never as 0%', () => {
  for (const env of [{ STUB_NODE_MEM_B: '<unknown>' }, { STUB_NODE_MEM: '<unknown>', STUB_NODE_MEM_B: '70' }]) {
    const r = rollout(env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /not checked/, JSON.stringify(env));
    assert.doesNotMatch(r.out, /Highest node memory/, JSON.stringify(env));
  }
});

test('k6 sending far fewer requests than the rate asks for is a failed run', () => {
  const r = rollout({ STUB_REQUESTS: '1000' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /only 1000 of about 4500/);
});

test('NAMESPACE and K6_IMAGE are checked before anything is applied', () => {
  for (const env of [{ NAMESPACE: 'a b' }, { K6_IMAGE: 'grafana/k6:2.3.0;rm' }]) {
    const r = rollout(env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.ok(!r.calls.some((c) => /apply|rollout restart/.test(c)), JSON.stringify(env));
  }
});
