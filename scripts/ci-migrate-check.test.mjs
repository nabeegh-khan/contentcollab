// Tests for ci-migrate-check.sh: migrations must survive up, down, up against
// the test job's Postgres before Jest runs (DB-9, TST-1, TST-5; docs/BUILD_LOG.md,
// 11 Nov). npm is a stub; nothing touches a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCi } from './ci-test-helper.mjs';

const WITH_MIGRATIONS = { 'migrations/1794275662371_init.js': 'export const up = () => {};\n' };

// failAt: the migrate command (e.g. "down 0") the stub npm refuses
const run = (files, failAt) =>
  runCi('ci-migrate-check.sh', {
    stubs: { npm: failAt ? `case "$*" in *"-- ${failAt}") echo "migration error"; exit 1;; esac` : 'exit 0' },
    files,
  });

test('skips while api/migrations does not exist (before #37 lands)', () => {
  const r = run({});
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, []);
  assert.match(r.out, /skipped/);
});

test('runs up, down 0, up, in that order', () => {
  const r = run(WITH_MIGRATIONS);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, ['npm run migrate -- up', 'npm run migrate -- down 0', 'npm run migrate -- up']);
});

test('a failing first up stops the run', () => {
  const r = runCi('ci-migrate-check.sh', {
    stubs: { npm: 'echo "syntax error"; exit 1' },
    files: WITH_MIGRATIONS,
  });
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.calls, ['npm run migrate -- up']);
  assert.match(r.out, /syntax error/);
});

test('a down that fails is reported as the down step and the second up never runs', () => {
  const r = run(WITH_MIGRATIONS, 'down 0');
  assert.notEqual(r.code, 0);
  assert.equal(r.calls.length, 2);
  assert.match(r.out, /::error::.*down 0/);
});

test('an up that fails after the down is reported as such (a down that leaves objects behind)', () => {
  // stub: the first up succeeds, the second fails, as it does when `down` forgot to drop a table
  const r = runCi('ci-migrate-check.sh', {
    stubs: {
      npm: 'n=$(wc -l < "$STUB_DIR/calls.log"); [ "$n" -ge 3 ] && { echo "relation \\"users\\" already exists"; exit 1; }; exit 0',
    },
    files: WITH_MIGRATIONS,
  });
  assert.notEqual(r.code, 0);
  assert.equal(r.calls.length, 3);
  assert.match(r.out, /::error::.*up after down/);
  assert.match(r.out, /already exists/);
});
