#!/usr/bin/env bash
# Checks the live demo's starting state before the slot (#174, D34, TST-3) and seeds what is missing through the API.
# In order: every pod Ready and the six components present, the api autoscaler, HTTPS 200 through the Gateway,
# /health with postgres and redis ok, the two demo accounts, the admin allowed into /ops and the reviewer
# refused, the documents "Demo document" and "Design review draft" (the draft hidden from the reviewer), and the
# draft's file downloading from Spaces. It stops at the first failure with one line that starts FAIL:.
# Reads the cluster (kubectl) and the site; the only writes are the seeding above.
#
#   read -rs DEMO_ADMIN_PASSWORD && export DEMO_ADMIN_PASSWORD
#   read -rs DEMO_REVIEWER_PASSWORD && export DEMO_REVIEWER_PASSWORD
#   KUBE_CONTEXT=do-nyc3-contentcollab scripts/demo-preflight.sh
# Settings: BASE (https://contentcollab.app), NAMESPACE (contentcollab). The passwords stay out of arguments:
# the sign-in body goes to curl on standard input and tokens go in a header file.
set -euo pipefail

: "${BASE:=https://contentcollab.app}"
: "${NAMESPACE:=contentcollab}"
BASE=${BASE%/}
API="$BASE/api/v1"
ADMIN_EMAIL=admin@contentcollab.app
REVIEWER_EMAIL=reviewer@contentcollab.app
DEMO_TITLE="Demo document"
DRAFT_TITLE="Design review draft"

fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }

[ -n "${KUBE_CONTEXT:-}" ] || fail "set KUBE_CONTEXT to the cluster to read (kubectl config get-contexts); the current context is never assumed"
for tool in kubectl curl jq; do command -v "$tool" >/dev/null || fail "missing tool: $tool"; done
case "$BASE" in https://*) ;; *) fail "BASE must be an https:// address, the demo is shown over HTTPS (got $BASE)" ;; esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# A native Windows curl cannot open a Git Bash /tmp path, so hand it the Windows form where cygpath exists
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

# req <method> <url> [curl args]: sets REPLY_CODE and REPLY_BODY; the body is read from standard input when given --data-binary @-
REPLY_CODE="" REPLY_BODY=""
req() {
  local method=$1 url=$2 out
  shift 2
  out=$(curl -sS --max-time 20 -X "$method" "$@" -w '\n%{http_code}' "$url") || fail "could not reach $url"
  REPLY_CODE=${out##*$'\n'}
  REPLY_BODY=${out%$'\n'*}
}
auth_header() { # auth_header <who> <token>: the header file for -H, so the token is not an argument
  printf 'Authorization: Bearer %s\n' "$2" > "$work/h-$1"
  chmod 600 "$work/h-$1"
  printf '@%s' "$(winpath "$work/h-$1")"
}

# 1. Pods
pods=$(k -n "$NAMESPACE" get pods -o json) || fail "could not read pods in $NAMESPACE on $KUBE_CONTEXT"
finished=$(jq '[.items[] | select(.status.phase == "Succeeded" or .status.phase == "Failed")] | length' <<<"$pods")
notready=$(jq -r '.items[] | select(.status.phase != "Succeeded" and .status.phase != "Failed")
  | select(((.status.containerStatuses // []) | length == 0) or ((.status.containerStatuses // []) | any(.ready | not)))
  | .metadata.name' <<<"$pods" | head -n 1)
[ -z "$notready" ] || fail "pod $notready is not Ready in $NAMESPACE"
names=$(jq -r '.items[] | select(.status.phase == "Running") | .metadata.name' <<<"$pods")
for comp in api web worker postgres redis contentcollab-nginx; do
  grep -q "^$comp-" <<<"$names" || fail "no ${comp/contentcollab-nginx/gateway} pod running in $NAMESPACE"
done
ok "all $(grep -c . <<<"$names") pods Ready, all six components present (ignored $finished finished job pod(s))"

# 2. Autoscaler
hpa=$(k -n "$NAMESPACE" get hpa api -o json) || fail "no autoscaler named api in $NAMESPACE (kubectl get hpa)"
ok "autoscaler api: $(jq -r '.status.currentReplicas' <<<"$hpa") running, may use $(jq -r '.spec.minReplicas' <<<"$hpa") to $(jq -r '.spec.maxReplicas' <<<"$hpa")"

# 3. Gateway and health
req GET "$BASE/"
[ "$REPLY_CODE" = 200 ] || fail "$BASE/ answered $REPLY_CODE through the Gateway, expected 200"
ok "$BASE/ answers 200 over HTTPS"
req GET "$BASE/health"
for part in postgres redis; do
  [ "$(jq -r --arg p "$part" '.[$p] // "missing"' <<<"$REPLY_BODY" 2>/dev/null)" = ok ] || fail "/health says $part is not ok (HTTP $REPLY_CODE): $(head -c 120 <<<"$REPLY_BODY")"
done
ok "/health: postgres and redis ok"

# 4. Accounts
for var in DEMO_ADMIN_PASSWORD DEMO_REVIEWER_PASSWORD; do
  [ -n "${!var:-}" ] || fail "set $var (read -rs $var && export $var); it is never kept in the repository"
done

# login <email> <password>: sets REPLY_CODE and REPLY_BODY
login() {
  local body
  body=$(E="$1" P="$2" jq -nc '{email: env.E, password: env.P}')
  req POST "$API/auth/login" -H 'Content-Type: application/json' --data-binary @- <<<"$body"
}
# account <label> <email> <password> <display name>: signs in, registering the account first if it is new; sets ACCOUNT_TOKEN and ACCOUNT_ID
ACCOUNT_TOKEN="" ACCOUNT_ID=""
account() {
  local label=$1 email=$2 password=$3 display=$4 body
  login "$email" "$password"
  if [ "$REPLY_CODE" = 401 ]; then
    body=$(E="$email" P="$password" D="$display" jq -nc '{email: env.E, password: env.P, displayName: env.D}')
    req POST "$API/auth/register" -H 'Content-Type: application/json' --data-binary @- <<<"$body"
    case "$REPLY_CODE" in
      201) echo "registered $email" ;;
      409) fail "$email exists but DEMO_$(tr a-z A-Z <<<"$label")_PASSWORD is not its password (nothing was changed)" ;;
      *) fail "registering $email answered $REPLY_CODE" ;;
    esac
    login "$email" "$password"
  fi
  [ "$REPLY_CODE" = 200 ] || fail "signing in as $email answered $REPLY_CODE"
  ACCOUNT_TOKEN=$(jq -r '.token' <<<"$REPLY_BODY")
  ACCOUNT_ID=$(jq -r '.user.id' <<<"$REPLY_BODY")
  ok "$email signs in"
}
account admin "$ADMIN_EMAIL" "$DEMO_ADMIN_PASSWORD" "Demo admin"
ADMIN_HDR=$(auth_header admin "$ACCOUNT_TOKEN")
account reviewer "$REVIEWER_EMAIL" "$DEMO_REVIEWER_PASSWORD" "Demo reviewer"
REVIEWER_HDR=$(auth_header reviewer "$ACCOUNT_TOKEN")
REVIEWER_ID=$ACCOUNT_ID

req GET "$API/ops" -H "$ADMIN_HDR"
[ "$REPLY_CODE" = 200 ] || fail "$ADMIN_EMAIL is refused by /ops ($REPLY_CODE): add its user id to OPS_ADMIN_USER_IDS in the cluster Secret"
req GET "$API/ops" -H "$REVIEWER_HDR"
[ "$REPLY_CODE" = 403 ] || fail "$REVIEWER_EMAIL is allowed into /ops ($REPLY_CODE): the demo shows it being refused"
ok "/ops lets the admin in and refuses the reviewer"

# 5. Documents: find_doc <header> <title> prints "id versionId" or nothing
find_doc() {
  local q
  q=$(jq -rn --arg t "$2" '$t | @uri')
  req GET "$API/documents?q=$q" -H "$1"
  [ "$REPLY_CODE" = 200 ] || fail "listing documents answered $REPLY_CODE"
  jq -r --arg t "$2" '[.items[] | select(.title == $t)] | first // empty | "\(.id) \(.currentVersionId)"' <<<"$REPLY_BODY"
}
# ensure_doc <title>: finds the admin's document or uploads one; sets DOC_ID and DOC_VERSION
DOC_ID="" DOC_VERSION=""
ensure_doc() {
  local title=$1 found file
  found=$(find_doc "$ADMIN_HDR" "$title")
  if [ -z "$found" ]; then
    file="$work/upload.txt"
    printf '%s\nA small text file for the live demo, uploaded by scripts/demo-preflight.sh.\n' "$title" > "$file"
    req POST "$API/documents" -H "$ADMIN_HDR" -F "title=$title" -F "file=@$(winpath "$file");type=text/plain"
    [ "$REPLY_CODE" = 201 ] || fail "uploading \"$title\" answered $REPLY_CODE"
    found=$(jq -r '"\(.id) \(.currentVersionId)"' <<<"$REPLY_BODY")
    echo "uploaded \"$title\""
  fi
  DOC_ID=${found% *}
  DOC_VERSION=${found#* }
  ok "\"$title\": $BASE/#/documents/$DOC_ID/versions/$DOC_VERSION"
}
ensure_doc "$DEMO_TITLE"
ensure_doc "$DRAFT_TITLE"
DRAFT_ID=$DOC_ID DRAFT_VERSION=$DOC_VERSION

# The share step needs one document the reviewer cannot see yet
if [ -n "$(find_doc "$REVIEWER_HDR" "$DRAFT_TITLE")" ]; then
  req GET "$API/documents/$DRAFT_ID/shares" -H "$ADMIN_HDR"
  [ "$REPLY_CODE" = 200 ] || fail "listing the shares of \"$DRAFT_TITLE\" answered $REPLY_CODE"
  share_id=$(jq -r --arg u "$REVIEWER_ID" '[.items[] | select(.userId == $u)] | first | .id // empty' <<<"$REPLY_BODY")
  [ -n "$share_id" ] || fail "the reviewer can see \"$DRAFT_TITLE\" but has no share by user id (a link share?): remove it by hand"
  req DELETE "$API/documents/$DRAFT_ID/shares/$share_id" -H "$ADMIN_HDR"
  [ "$REPLY_CODE" = 204 ] || fail "removing the reviewer's share answered $REPLY_CODE"
  [ -z "$(find_doc "$REVIEWER_HDR" "$DRAFT_TITLE")" ] || fail "the reviewer still sees \"$DRAFT_TITLE\" after the share was removed"
  echo "removed the reviewer's share of \"$DRAFT_TITLE\""
fi
ok "the reviewer cannot see \"$DRAFT_TITLE\" yet"

# 6. Spaces: the API reads the file back from the bucket
req GET "$API/documents/$DRAFT_ID/versions/$DRAFT_VERSION/content" -H "$ADMIN_HDR"
{ [ "$REPLY_CODE" = 200 ] && [ -n "$REPLY_BODY" ]; } || fail "Spaces: the file of \"$DRAFT_TITLE\" did not download (HTTP $REPLY_CODE)"
ok "the file of \"$DRAFT_TITLE\" downloads from Spaces"

echo "preflight passed"
