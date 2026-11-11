#!/usr/bin/env bash
# Proves check-manifests.sh can fail: the bad fixture breaks INF-8, INF-9,
# INF-10, INF-11, OBS-5 and SEC-6, and each row must be reported.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(bash "$here/check-manifests.sh" < "$here/testdata/manifests-bad.yaml" || true)
status=0
for row in INF-8 INF-9 INF-10 INF-11 OBS-5 SEC-6; do
  grep -q "^FAIL $row " <<<"$out" || { echo "check-manifests.sh did not report $row on the bad fixture"; status=1; }
done
bash "$here/check-manifests.sh" < "$here/testdata/manifests-bad.yaml" >/dev/null && { echo "check-manifests.sh passed the bad fixture"; status=1; }
[ "$status" = 0 ] && echo "ok: every row is reported on the bad fixture"
exit "$status"
