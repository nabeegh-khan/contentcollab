#!/usr/bin/env bash
# The checks run by hand before every demo (TST-3): read the bodies, not just
# the status codes. BASE is the deployed URL or a local port-forward (default);
# deploy.yml's own smoke step checks /health after each rollout. /metrics is
# never routed by the Gateway (SEC-4), so it is checked through a port-forward
# only: METRICS_BASE, which defaults to BASE when BASE is localhost. Exits
# non-zero on the first failure.
set -euo pipefail
: "${BASE:=http://localhost:3000}"
case "$BASE" in
  http://localhost:*|http://127.0.0.1:*) : "${METRICS_BASE:=$BASE}" ;;
  *) : "${METRICS_BASE:=}" ;;
esac

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "ok: $*"; }

# Here-strings, not `echo | grep -q`: grep stops at the first match, and under
# pipefail the echo it leaves writing fails the pipeline when the body is large
body=$(curl -sS --max-time 10 "$BASE/health") || fail "/health unreachable at $BASE"
grep -q '"status":"ok"' <<<"$body"   || fail "/health not ok: $body"
grep -q '"postgres":"ok"' <<<"$body" || fail "postgres down: $body"
grep -q '"redis":"ok"' <<<"$body"    || fail "redis down: $body"
pass "/health reports postgres and redis"

if [ -n "$METRICS_BASE" ]; then
  metrics=$(curl -sS --max-time 10 "$METRICS_BASE/metrics") || fail "/metrics unreachable at $METRICS_BASE"
  grep -q '^http_requests_total' <<<"$metrics" || fail "/metrics has no http_requests_total"
  pass "/metrics exposes request counters"
else
  echo "skip: /metrics is not routed at $BASE; set METRICS_BASE to a port-forward (kubectl -n contentcollab port-forward svc/api 3000:3000)"
fi

# Under /api, so the Gateway passes it on and the 404 is the API's own
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/no-such-route") \
  || fail "unknown-route probe unreachable at $BASE"
[ "$code" = "404" ] || fail "unknown route returned $code, expected 404"
body=$(curl -sS --max-time 10 "$BASE/api/no-such-route") || fail "unknown-route probe unreachable at $BASE"
grep -q '"error":"Not Found"' <<<"$body" || fail "the 404 did not come from the API: $body"
pass "unknown route is the API's 404, not a crash"

echo "smoke passed against $BASE"
