#!/usr/bin/env bash
# The checks run before every demo and after every rollout (TST-3): read the
# bodies, not just the status codes. BASE is the deployed URL or a local
# port-forward (default). Exits non-zero on the first failure.
set -euo pipefail
: "${BASE:=http://localhost:3000}"

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "ok: $*"; }

body=$(curl -sS --max-time 10 "$BASE/health") || fail "/health unreachable at $BASE"
echo "$body" | grep -q '"status":"ok"'     || fail "/health not ok: $body"
echo "$body" | grep -q '"postgres":"ok"'   || fail "postgres down: $body"
echo "$body" | grep -q '"redis":"ok"'      || fail "redis down: $body"
pass "/health reports postgres and redis"

metrics=$(curl -sS --max-time 10 "$BASE/metrics") || fail "/metrics unreachable"
echo "$metrics" | grep -q '^http_requests_total' || fail "/metrics has no http_requests_total"
pass "/metrics exposes request counters"

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/no-such-route")
[ "$code" = "404" ] || fail "unknown route returned $code, expected 404"
pass "unknown route is a 404, not a crash"

echo "smoke passed against $BASE"
