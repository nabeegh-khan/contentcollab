# Stand-in AWS CLI with a one-bucket fake store in $STUB_DIR/store, for scripts/spaces-verify.test.mjs.
# Logs its arguments, records the key it was given in the environment and the size of each upload.
#   STUB_BUCKET=name      the one bucket this key reaches
#   STUB_FAIL=word        a call whose arguments contain the word fails with AccessDenied
#   STUB_FOREIGN_OK=1     writes to another bucket succeed (a key that is not limited to its bucket)
#   STUB_FOREIGN_MISSING=1  writes to another bucket fail with NoSuchBucket
#   STUB_CORRUPT=1        downloads return different bytes
#   STUB_CORRUPT_COPY=1   a server-side copy changes the bytes
echo "$*" >> "$STUB_DIR/aws.argv"
echo "${AWS_ACCESS_KEY_ID:-}:${AWS_SECRET_ACCESS_KEY:-}" > "$STUB_DIR/aws.env"
store="$STUB_DIR/store"
denied() { echo "An error occurred (AccessDenied) when calling the $1 operation: Access Denied" >&2; exit 254; }
if [ -n "${STUB_FAIL:-}" ]; then case "$*" in *"$STUB_FAIL"*) denied "$STUB_FAIL" ;; esac; fi

[ "$1" = --endpoint-url ] && [ "$3" = --region ] || { echo "aws-stub: expected --endpoint-url E --region R first, got: $*" >&2; exit 2; }
shift 4
service=$1; op=$2; shift 2

bucket=""; key=""; body=""; source=""; positional=()
while [ $# -gt 0 ]; do
  case "$1" in
    --bucket) bucket=$2; shift 2 ;;
    --key) key=$2; shift 2 ;;
    --body) body=$2; shift 2 ;;
    --copy-source) source=$2; shift 2 ;;
    --content-type) shift 2 ;;
    *) positional+=("$1"); shift ;;
  esac
done

put() { # put <bucket> <key> <file>
  if [ "$1" != "$STUB_BUCKET" ]; then
    [ "${STUB_FOREIGN_MISSING:-0}" = 1 ] && { echo "An error occurred (NoSuchBucket) when calling the PutObject operation: The specified bucket does not exist" >&2; exit 254; }
    [ "${STUB_FOREIGN_OK:-0}" = 1 ] || denied PutObject
  fi
  mkdir -p "$(dirname "$store/$1/$2")"; cp "$3" "$store/$1/$2"
  echo "$1/$2 $(wc -c < "$3")" >> "$STUB_DIR/aws.sizes"
}
get() { # get <bucket> <key> <file>
  [ -f "$store/$1/$2" ] || { echo "An error occurred (NoSuchKey) when calling the GetObject operation: not found" >&2; exit 254; }
  cp "$store/$1/$2" "$3"
  [ "${STUB_CORRUPT:-0}" = 1 ] && echo corrupt >> "$3"
  return 0
}
s3uri() { local rest=${1#s3://}; echo "${rest%%/*} ${rest#*/}"; }

case "$service $op" in
  "s3api head-bucket") [ "$bucket" = "$STUB_BUCKET" ] || denied HeadBucket ;;
  "s3api put-object") put "$bucket" "$key" "$body" ;;
  "s3api get-object") get "$bucket" "$key" "${positional[0]}" ;;
  "s3api head-object") [ -f "$store/$bucket/$key" ] || { echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254; } ;;
  "s3api copy-object")
    read -r sb sk <<< "${source/\// }"; get "$sb" "$sk" "$STUB_DIR/copy.tmp"
    [ "${STUB_CORRUPT_COPY:-0}" = 1 ] && echo changed >> "$STUB_DIR/copy.tmp"
    put "$bucket" "$key" "$STUB_DIR/copy.tmp" ;;
  "s3api delete-object") rm -f "$store/$bucket/$key" ;;
  "s3 cp")
    if [[ "${positional[0]}" == s3://* ]]; then read -r b k <<< "$(s3uri "${positional[0]}")"; get "$b" "$k" "${positional[1]}"
    else read -r b k <<< "$(s3uri "${positional[1]}")"; put "$b" "$k" "${positional[0]}"; fi ;;
  *) echo "aws-stub: unexpected call: $service $op" >&2; exit 2 ;;
esac
