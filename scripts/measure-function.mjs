// Times the compare function from this machine (#180, ARCHITECTURE D39): a burst of parallel calls (each
// needs its own container, since one container runs one call at a time) and then sequential calls on
// warm containers. The same input is diffed in this process with the module the API and the worker use, for
// the local comparison. Reads the address and the shared value from the environment; prints no value of them.
//
//   $env:FUNCTION_DIFF_URL="https://..."; $env:FUNCTION_AUTH_TOKEN="..."; node scripts/measure-function.mjs 2000
import { createRequire } from "node:module";

const { FUNCTION_DIFF_URL: url, FUNCTION_AUTH_TOKEN: token } = process.env;
if (!url || !token) {
  console.error("Set FUNCTION_DIFF_URL and FUNCTION_AUTH_TOKEN");
  process.exit(1);
}

const LINES = Number(process.argv[2] ?? 2000);
const CALLS = 10;
const CHANGE_EVERY = 10;
const MS_DIGITS = 1;

const before = Array.from({ length: LINES }, (_, i) => `line ${i}: the quick brown fox ${i * 7}`).join("\n");
const after = before
  .split("\n")
  .map((line, i) => (i % CHANGE_EVERY === 0 ? `${line} (edited)` : line))
  .join("\n");

const round = (n) => Number(n.toFixed(MS_DIGITS));
const middle = (sorted) => sorted[Math.floor(sorted.length / 2)];

async function call() {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Require-Whisk-Auth": token },
    body: JSON.stringify({ before, after }),
  });
  const body = await response.json();
  return {
    status: response.status,
    wallMs: round(performance.now() - started),
    computeMs: body.computeMs ?? null,
    lines: body.lines?.length ?? null,
  };
}

function summary(label, results) {
  const wall = results.map((r) => r.wallMs).sort((a, b) => a - b);
  const compute = results.map((r) => r.computeMs).filter((n) => n !== null).sort((a, b) => a - b);
  return {
    label,
    calls: results.length,
    statuses: [...new Set(results.map((r) => r.status))],
    wallMs: { min: wall[0], median: middle(wall), max: wall[wall.length - 1] },
    computeMs: compute.length ? { min: compute[0], median: middle(compute), max: compute[compute.length - 1] } : null,
    allWall: wall,
  };
}

const burst = await Promise.all(Array.from({ length: CALLS }, call));
const warm = [];
for (let i = 0; i < CALLS; i += 1) warm.push(await call());

// The same diff in this process, with the function's own module
const { lineDiff } = createRequire(import.meta.url)("../functions/packages/compare/diff/diff.js");
const local = Array.from({ length: CALLS }, () => {
  const started = performance.now();
  lineDiff(before, after);
  return { status: 200, wallMs: round(performance.now() - started), computeMs: null };
});

console.log(
  JSON.stringify(
    {
      inputBytes: Buffer.byteLength(before) + Buffer.byteLength(after),
      inputLines: LINES,
      burst: summary("parallel burst (cold containers)", burst),
      warm: summary("sequential after the burst (warm)", warm),
      local: summary("same diff in this process", local),
    },
    null,
    2,
  ),
);
