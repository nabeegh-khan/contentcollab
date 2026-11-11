// Drives scripts/rollout-no-drop.sh through a stub kubectl (#69): the verdict
// logic only, with no cluster. The real behaviour is the k3s before/after run
// in docs/BUILD_LOG.md. Run: node --test scripts/ (BASH_BIN=path-to-bash on
// Windows, where `bash` may resolve to WSL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
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
