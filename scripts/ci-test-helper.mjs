// Shared by the scripts/ci-*.test.mjs files: runs one of the CI shell scripts
// with stub tools on PATH, inside a throw-away directory that holds a fixture
// tree. Each stub appends "<name> <args>" to calls.log and then runs its own
// body, so a test can assert on what the script called and in what order.
// Nothing reaches a cluster, a registry or the network. Run: node --test scripts/
// (BASH_BIN=path-to-bash on Windows, where `bash` may resolve to WSL).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptsDir = dirname(fileURLToPath(import.meta.url));
const BASH = process.env.BASH_BIN || 'bash';

// Bash splits PATH at the colon of a drive letter (C:\...), which would let
// the real tool run instead of the stub; /c/... has no colon
export const posix = (p) =>
  process.platform === 'win32'
    ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
    : p;

// Refuses to run unless every stubbed tool resolves to its stub
const guard = (names) => `export PATH="$STUB_DIR:/usr/bin:/bin"
for t in ${names.join(' ')}; do
  [ "$(command -v $t)" = "$STUB_DIR/$t" ] || { echo "stub guard: $t is $(command -v $t)"; exit 99; }
done
exec bash "$0" "$@"`;

const readLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);

/**
 * @param {string} script   file name inside scripts/
 * @param {object} o
 * @param {Record<string,string>} o.stubs  tool name -> shell body run after logging
 * @param {Record<string,string>} [o.files] fixture files, path relative to the working directory
 * @param {Record<string,string>} [o.env]
 * @param {string[]} [o.args] arguments for the script
 * @returns {{code:number, out:string, calls:string[], written:Record<string,string>}}
 *   written: every file the script left in OUT_DIR, by name
 */
export function runCi(script, { stubs, files = {}, env = {}, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-script-'));
  try {
    const bin = join(dir, 'bin');
    const work = join(dir, 'work');
    const outDir = join(dir, 'out');
    mkdirSync(bin);
    mkdirSync(work);
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_DIR/calls.log"\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    }
    const r = spawnSync(BASH, ['-c', guard(Object.keys(stubs)), posix(join(scriptsDir, script)), ...args], {
      cwd: work,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, STUB_DIR: posix(bin), OUT_DIR: posix(outDir), ...env },
    });
    const written = {};
    if (existsSync(outDir)) for (const f of readdirSync(outDir)) written[f] = readFileSync(join(outDir, f), 'utf8');
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: readLines(join(bin, 'calls.log')), written };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
