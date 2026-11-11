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

test('a node without room for the load generator: refuses before starting the load or the restart', () => {
  // 2700Mi used of 3074892Ki (3002Mi) leaves 302Mi, under k6's 512Mi limit,
  // on either node
  for (const env of [{ STUB_USED: '2700Mi' }, { STUB_USED_B: '2700Mi' }]) {
    const r = rollout(env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.out, /302 MiB free/, JSON.stringify(env));
    assert.ok(!r.calls.some((c) => /rollout restart|apply/.test(c)), JSON.stringify(env));
  }
});

// The cluster rebuilt on 11 November is not the two 2 GB nodes the first
// version assumed: the shape, the context and the room on the nodes come from
// the cluster, in bytes, whatever the node count or size

test('one 4 GB node at 89%: a percentage limit of 90 would pass it, the headroom check does not', () => {
  const r = rollout({ STUB_NODES: '1', STUB_USED: '2680Mi', STUB_NODE_MEM: '89' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /node-a has 322 MiB free/);
  assert.ok(!r.calls.some((c) => /rollout restart|apply/.test(c)), r.calls.join('\n'));
});

test('one 4 GB node with room: runs, and prints the node count, size and autoscaler bounds it read', () => {
  const r = rollout({ STUB_NODES: '1', STUB_USED: '1500Mi' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Cluster: stub-cluster/);
  assert.match(r.out, /Nodes: 1 \(node-a s-2vcpu-4gb 3002 MiB allocatable\)/);
  assert.match(r.out, /Node autoscaling: min 1, max 2/);
  assert.match(r.out, /Least free memory: node-a 1502 MiB \(needs 768\)/);
});

test('two 2 GB nodes still work: allocatable read in any unit', () => {
  const r = rollout({ STUB_TYPE: 's-2vcpu-2gb', STUB_ALLOC: '1.6Gi', STUB_ALLOC_B: '1678Mi', STUB_USED: '800Mi', STUB_USED_B: '900Mi' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Nodes: 2 \(node-a s-2vcpu-2gb 1638 MiB allocatable, node-b s-2vcpu-2gb 1678 MiB allocatable\)/);
  assert.match(r.out, /Least free memory: node-b 778 MiB/);
});

test('the headroom asked for is the k6 pod\'s limit plus the surge pods\', read from the Deployment', () => {
  const r = rollout({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.applied, /limits: \{cpu: "1", memory: 512Mi\}/);
  assert.match(r.out, /\(needs 768\)/);
  const two = rollout({ STUB_SURGE: '2', STUB_API_LIMIT: '0.5Gi' });
  assert.match(two.out, /\(needs 1536\)/);
  const more = rollout({ MIN_NODE_FREE_MIB: '2000' });
  assert.equal(more.code, 1, more.out);
  assert.match(more.out, /MIN_NODE_FREE_MIB=2000/);
});

test('no kubectl context: stops before anything is applied', () => {
  const r = rollout({ STUB_NO_CONTEXT: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /context/);
  assert.ok(!r.calls.some((c) => /apply|rollout restart/.test(c)), r.calls.join('\n'));
});

test('autoscaler status not readable: says so and carries on', () => {
  const r = rollout({ STUB_NO_CAS: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Node autoscaling: not readable/);
});

test('MIN_NODE_FREE_MIB that is not a number stops the run before any change', () => {
  // The script's own check, not a later shell error; a number too big for
  // bash's arithmetic is refused the same way
  for (const v of ['lots', '99999999999999999999']) {
    const r = rollout({ MIN_NODE_FREE_MIB: v, ALLOW_UNCHECKED_MEMORY: '1', STUB_USED: '<unknown>', STUB_USED_B: '<unknown>' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /MIN_NODE_FREE_MIB '[^']*' is not a number of MiB/, v);
    assert.ok(!r.calls.some((c) => /apply|rollout restart/.test(c)), r.calls.join('\n'));
  }
});

test('an allocatable figure in a unit it cannot read is not checked, never guessed', () => {
  const r = rollout({ STUB_ALLOC_B: '3e9' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /node-b: memory not readable, not checked/);
  assert.match(r.out, /ALLOW_UNCHECKED_MEMORY/);
  const ok = rollout({ STUB_ALLOC_B: '3e9', ALLOW_UNCHECKED_MEMORY: '1' });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /Least free memory: node-a/);
});

// Review round on the cluster-shape change: every readable node is checked,
// a node with no metrics is never counted as empty, and the threshold
// includes the pod the rollout adds

test('a full node is refused even when another node has no metrics yet', () => {
  for (const env of [{ STUB_USED: '2950Mi', STUB_USED_B: '<unknown>' }, { STUB_USED: '2950Mi', STUB_TOP_MISSING_B: '1' }]) {
    const r = rollout(env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /node-a has 52 MiB free/, JSON.stringify(env));
    assert.ok(!r.calls.some((c) => /rollout restart|apply/.test(c)), JSON.stringify(env));
  }
});

test('a node listed by get nodes but missing from kubectl top is not checked, never counted as empty', () => {
  // Unchecked means the load or the surge pod could land there: refused
  // unless the operator says so
  const r = rollout({ STUB_TOP_MISSING_B: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /node-b: memory not readable, not checked/);
  assert.match(r.out, /ALLOW_UNCHECKED_MEMORY/);
  assert.ok(!r.calls.some((c) => /rollout restart|apply/.test(c)), r.calls.join('\n'));
  const ok = rollout({ STUB_TOP_MISSING_B: '1', ALLOW_UNCHECKED_MEMORY: '1' });
  assert.equal(ok.code, 0, ok.out);
  assert.doesNotMatch(ok.out, /node-b 3002 MiB/);
});

test('only ALLOW_UNCHECKED_MEMORY=1 lets an unchecked run go ahead', () => {
  for (const v of ['yes', 'true', '0', '']) {
    const r = rollout({ STUB_NODES: '1', STUB_USED: '<unknown>', ALLOW_UNCHECKED_MEMORY: v });
    assert.equal(r.code, 1, `ALLOW_UNCHECKED_MEMORY=${v}: ${r.out}`);
  }
});

test('the api memory limit is rounded up and read from the container named api', () => {
  const r = rollout({ STUB_API_LIMIT: '300.5Mi' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\(needs 813\)/);
  assert.ok(r.calls.some((c) => /containers\[\?\(@\.name=="api"\)\]\.resources\.limits\.memory/.test(c)), r.calls.join('\n'));
});

test('no node readable at all: refuses unless ALLOW_UNCHECKED_MEMORY=1', () => {
  const env = { STUB_NODES: '1', STUB_USED: '<unknown>' };
  const r = rollout(env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ALLOW_UNCHECKED_MEMORY/);
  assert.ok(!r.calls.some((c) => /rollout restart|apply/.test(c)), r.calls.join('\n'));
  const ok = rollout({ ...env, ALLOW_UNCHECKED_MEMORY: '1' });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /not checked/);
});

test('free memory exactly at the threshold passes; one MiB under refuses', () => {
  // 3002 - 2234 = 768 = 512 (k6) + 256 (one surge api pod)
  const at = rollout({ STUB_NODES: '1', STUB_USED: '2234Mi' });
  assert.equal(at.code, 0, at.out);
  const under = rollout({ STUB_NODES: '1', STUB_USED: '2235Mi' });
  assert.equal(under.code, 1, under.out);
  assert.match(under.out, /767 MiB free/);
});

test('an empty context name is refused like a missing one', () => {
  const r = rollout({ STUB_EMPTY_CONTEXT: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /context/);
  assert.ok(!r.calls.some((c) => /apply|rollout restart/.test(c)), r.calls.join('\n'));
});

test('an api memory limit or maxSurge it cannot read stops the run before any change', () => {
  for (const env of [{ STUB_API_LIMIT: '' }, { STUB_SURGE: '25%' }]) {
    const r = rollout(env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.out, /surge/, JSON.stringify(env));
    assert.ok(!r.calls.some((c) => /apply|rollout restart/.test(c)), JSON.stringify(env));
  }
});

test('MIN_NODE_FREE_MIB set: the run goes ahead even when the surge cannot be sized', () => {
  // maxSurge defaults to "25%" on a Deployment that does not set it
  for (const env of [{ STUB_SURGE: '25%' }, { STUB_API_LIMIT: '' }]) {
    const r = rollout({ ...env, MIN_NODE_FREE_MIB: '800' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\(needs 800\)/, JSON.stringify(env));
  }
});

test('usage is rounded up, so a fraction of a MiB never lets a node through', () => {
  // 3002 - 2234.5 is under 768
  const r = rollout({ STUB_NODES: '1', STUB_USED: '2234.5Mi' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /767 MiB free/);
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

test('a node whose memory is unknown is reported as not checked, never as free', () => {
  for (const [env, node] of [[{ STUB_USED_B: '<unknown>' }, 'node-b'], [{ STUB_USED: '<unknown>' }, 'node-a']]) {
    const r = rollout({ ...env, ALLOW_UNCHECKED_MEMORY: '1' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`${node}: memory not readable, not checked`), JSON.stringify(env));
    assert.doesNotMatch(r.out, new RegExp(`Least free memory: ${node}`), JSON.stringify(env));
    assert.equal(rollout(env).code, 1, JSON.stringify(env));
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
