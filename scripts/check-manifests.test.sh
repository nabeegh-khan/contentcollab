#!/usr/bin/env bash
# Proves check-manifests.sh can fail, one sub-check at a time: the bad fixture
# breaks every rule, and each message below must appear. Lines that must NOT
# appear cover what the script is meant to leave alone, and empty or malformed
# input must not print "ok".
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
check="$here/check-manifests.sh"
out=$(bash "$check" < "$here/testdata/manifests-bad.yaml" || true)
status=0

expect() { grep -qF -- "$1" <<<"$out" || { echo "missing: $1"; status=1; }; }
refuse() { ! grep -qF -- "$1" <<<"$out" || { echo "unexpected: $1"; status=1; }; }

expect "FAIL INF-8 broken: selector app=broken is not a pod template label"
expect "FAIL INF-8 service/orphan: no workload labelled app=nobody"
expect "FAIL INF-9 broken: image nginx has no tag or is :latest"
expect "FAIL INF-9 floating: image redis:latest has no tag or is :latest"
expect "FAIL INF-9 named-wrong: image busybox has no tag or is :latest"
expect "FAIL INF-10 broken: containerPort 8080 has no name"
expect "FAIL INF-10 named-wrong: containerPort 9000 has no name"
expect "FAIL INF-10 broken: probe port 8080 is not a port name"
expect "FAIL INF-10 named-wrong: probe port web is not a port name"
expect "FAIL INF-10 named-wrong: probe port 3000 is not a port name"
expect "FAIL INF-10 service/orphan: targetPort 8080 is not a port name declared by app=nobody"
expect "FAIL INF-10 service/wrong-target: targetPort nope is not a port name declared by app=named-wrong"
expect "FAIL INF-11 broken: livenessProbe calls /health"
expect "FAIL OBS-5 broken/broken: missing"
expect "FAIL OBS-5 floating/floating: missing"
expect "FAIL OBS-5 named-wrong/init: missing"
expect "FAIL SEC-6 broken/broken: runAsNonRoot is not true"
expect "FAIL SEC-6 named-wrong/main: runAsNonRoot is not true"
expect "FAIL SEC-6 post/post: runAsNonRoot is not true"
refuse "FAIL SEC-6 postgres"
refuse "migrate"
refuse "external"
bash "$check" < "$here/testdata/manifests-bad.yaml" >/dev/null && { echo "passed the bad fixture"; status=1; }

empty=$(bash "$check" < /dev/null || true)
grep -q "^ok" <<<"$empty" && { echo "empty input printed ok"; status=1; }
bad=$(printf 'kind: [unclosed\n' | bash "$check" 2>&1 || true)
grep -q "^ok" <<<"$bad" && { echo "malformed YAML printed ok"; status=1; }

[ "$status" = 0 ] && echo "ok: every sub-check is reported on the bad fixture"
exit "$status"
