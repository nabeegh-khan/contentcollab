#!/usr/bin/env bash
# Proves that a Spaces access key does what the API needs and nothing wider (#53, #40): put and get a
# small object, a multipart upload and download, a server-side copy, delete; the bucket refuses an
# anonymous read; and, when FOREIGN_BUCKET names another existing bucket, the key is refused there.
# Everything it writes goes under probe/ and is deleted again. Needs the AWS CLI (v2) and curl.
#
#   read -rs SPACES_SECRET && export SPACES_SECRET     # so it stays out of the shell history
#   SPACES_KEY=... FOREIGN_BUCKET=contentcollab-backups scripts/spaces-verify.sh
#
# Settings come from k8s/base/configmap.yaml unless SPACES_ENDPOINT, SPACES_REGION or SPACES_BUCKET
# are set. The key reaches the AWS CLI through its environment, never as an argument.
set -euo pipefail
cd "$(dirname "$0")/.."

from_config() { awk -v key="$1:" '$1 == key { gsub(/["\r]/, "", $2); print $2; exit }' k8s/base/configmap.yaml; }
: "${SPACES_ENDPOINT:=$(from_config SPACES_ENDPOINT)}"
: "${SPACES_REGION:=$(from_config SPACES_REGION)}"
: "${SPACES_BUCKET:=$(from_config SPACES_BUCKET)}"
: "${FOREIGN_BUCKET:=}"

for tool in aws curl; do command -v "$tool" >/dev/null || { echo "missing: $tool"; exit 1; }; done
if [ -z "${SPACES_KEY:-}" ] || [ -z "${SPACES_SECRET:-}" ]; then
  echo "set SPACES_KEY and SPACES_SECRET (read -rs SPACES_SECRET && export SPACES_SECRET keeps it out of the history)"
  exit 1
fi
export AWS_ACCESS_KEY_ID="$SPACES_KEY" AWS_SECRET_ACCESS_KEY="$SPACES_SECRET" AWS_EC2_METADATA_DISABLED=true AWS_PAGER=""
unset AWS_SESSION_TOKEN AWS_PROFILE

sp() { aws --endpoint-url "$SPACES_ENDPOINT" --region "$SPACES_REGION" "$@"; }
work=$(mktemp -d)
# Git Bash on Windows: the native AWS CLI cannot open /tmp/..., so hand it C:/... (a no-op elsewhere)
if command -v cygpath >/dev/null; then work=$(cygpath -m "$work"); fi
prefix="probe/$(date +%s)-$$"
foreign_written=false
cleanup() {
  for object in small.txt big.bin copy.txt; do sp s3api delete-object --bucket "$SPACES_BUCKET" --key "$prefix/$object" >/dev/null 2>&1 || true; done
  if [ "$foreign_written" = true ]; then sp s3api delete-object --bucket "$FOREIGN_BUCKET" --key "$prefix/foreign.txt" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

fails=0
step() { # step <name> <function>: prints ok or FAIL with the first lines of what the function said
  local name=$1; shift
  if "$@" >"$work/out" 2>&1; then
    printf 'ok    %s\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"; head -n 5 "$work/out" | sed 's/^/        /'; fails=$((fails + 1))
  fi
}

bucket_reachable() { sp s3api head-bucket --bucket "$SPACES_BUCKET"; }
small_round_trip() {
  printf 'contentcollab probe %s\n' "$prefix" > "$work/small.txt"
  sp s3api put-object --bucket "$SPACES_BUCKET" --key "$prefix/small.txt" --body "$work/small.txt" --content-type text/plain || return 1
  sp s3api get-object --bucket "$SPACES_BUCKET" --key "$prefix/small.txt" "$work/small.back" || return 1
  cmp "$work/small.txt" "$work/small.back"
}
multipart_round_trip() { # 12 MiB: above the CLI's 8 MiB threshold, so it goes up in parts like the API's Upload
  head -c 12582912 /dev/urandom > "$work/big.bin"
  sp s3 cp "$work/big.bin" "s3://$SPACES_BUCKET/$prefix/big.bin" --only-show-errors || return 1
  sp s3 cp "s3://$SPACES_BUCKET/$prefix/big.bin" "$work/big.back" --only-show-errors || return 1
  cmp "$work/big.bin" "$work/big.back"
}
server_side_copy() {
  sp s3api copy-object --bucket "$SPACES_BUCKET" --key "$prefix/copy.txt" --copy-source "$SPACES_BUCKET/$prefix/small.txt" || return 1
  sp s3api get-object --bucket "$SPACES_BUCKET" --key "$prefix/copy.txt" "$work/copy.back" || return 1
  cmp "$work/small.txt" "$work/copy.back"
}
anonymous_refused() { # path-style address, which Spaces supports; an unsigned request must not read a private object
  local code
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$SPACES_ENDPOINT/$SPACES_BUCKET/$prefix/small.txt")
  [ "$code" = 403 ] || { echo "an anonymous GET answered HTTP $code, expected 403"; return 1; }
}
foreign_refused() {
  printf 'foreign\n' > "$work/foreign.txt"
  if sp s3api put-object --bucket "$FOREIGN_BUCKET" --key "$prefix/foreign.txt" --body "$work/foreign.txt" >"$work/foreign.out" 2>&1; then
    foreign_written=true
    echo "the key wrote to $FOREIGN_BUCKET: it is not limited to its own bucket"; return 1
  fi
  grep -q AccessDenied "$work/foreign.out" || { echo "refused, but not with AccessDenied: the bucket does not exist, or the error is something else:"; cat "$work/foreign.out"; return 1; }
}
probes_deleted() {
  # a loop variable named like step's local would overwrite it (bash scopes locals dynamically)
  for object in small.txt big.bin copy.txt; do sp s3api delete-object --bucket "$SPACES_BUCKET" --key "$prefix/$object" || return 1; done
  if sp s3api head-object --bucket "$SPACES_BUCKET" --key "$prefix/small.txt" >/dev/null 2>&1; then echo "small.txt is still there after delete"; return 1; fi
}

echo "Spaces key check: bucket $SPACES_BUCKET at $SPACES_ENDPOINT (region $SPACES_REGION)"
step "bucket reachable" bucket_reachable
[ "$fails" -eq 0 ] || { echo "cannot continue: check the bucket name, the endpoint and the key"; exit 1; }
step "small object round trip" small_round_trip
step "multipart upload round trip" multipart_round_trip
step "server-side copy" server_side_copy
step "anonymous read refused" anonymous_refused
if [ -n "$FOREIGN_BUCKET" ]; then
  step "key refused on $FOREIGN_BUCKET" foreign_refused
else
  echo "skip  key scope: set FOREIGN_BUCKET to another existing bucket to prove the key cannot reach it"
fi
step "probe objects deleted" probes_deleted

[ "$fails" -eq 0 ] || { echo "$fails step(s) failed"; exit 1; }
echo "Key verified."
