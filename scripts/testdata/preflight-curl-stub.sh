# Stand-in curl for scripts/demo-preflight.test.mjs (#174): a small fake of the ContentCollab API and the Gateway.
# shellcheck shell=bash
# It logs every request ("METHOD URL") to $STUB_DIR/curl.requests, every argument line to $STUB_DIR/curl.argv and every
# request body read from standard input to $STUB_DIR/curl.bodies. The script calls it as
#   curl -sS --max-time N -X METHOD [-H @headerfile] [-F name=value ...] [--data-binary @-] -w '\n%{http_code}' URL
# and gets the body, a newline and the status code. Accounts: admin@ (tok-admin, password pw-admin-1) and
# reviewer@ (tok-reviewer, pw-reviewer-1); anything else signs in with a 401.
#   STUB_GATEWAY_CODE=<n>     GET / answers n (default 200)
#   STUB_REDIS_DOWN=1, STUB_PG_DOWN=1   /health answers 503 with that part down
#   STUB_NO_ADMIN=1, STUB_NO_REVIEWER=1 the account does not exist until /auth/register is called for it
#   STUB_ADMIN_NOT_OPS=1      /ops refuses the admin (403)
#   STUB_REVIEWER_OPS=1       /ops lets the reviewer in
#   STUB_NO_DEMO=1, STUB_NO_DRAFT=1   that document does not exist until it is uploaded
#   STUB_DRAFT_SHARED=1       the draft is shared with the reviewer (share-1)
#   STUB_CONTENT_CODE=<n>     a version's content answers n (default 200)
#   STUB_CURL_FAIL=1          curl cannot reach the site (exit 7)
#   STUB_DOCS_CODE=<n>        GET /documents answers n with an empty object
#   STUB_LOGIN_HTML=1         sign-in answers 200 with an HTML page
#   STUB_LOGIN_NO_TOKEN=1     sign-in answers 200 with a body that has no token
#   STUB_HEALTH_MULTILINE=1   /health bodies are pretty-printed over several lines
#   STUB_DUP_DEMO=1           the admin has two documents titled "Demo document"
#   STUB_REVIEWER_OWN_DRAFT=1 the reviewer owns a document titled "Design review draft" (doc-rev-own)
#   STUB_DELETE_CODE=<n>      deleting a share answers n (default 204)
#   STUB_REGISTER_CODE=<n>    registering answers n instead of creating the account
printf '%s\n' "$@" >> "$STUB_DIR/curl.argv"

method=GET url="" hdr="" title="" stdin_body=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    -X) method=${args[i + 1]} ;;
    -H) hdr=${args[i + 1]#@} ;;
    -F) case "${args[i + 1]}" in title=*) title=${args[i + 1]#title=} ;; esac ;;
    --data-binary) stdin_body=$(cat) ; printf '%s\n' "$stdin_body" >> "$STUB_DIR/curl.bodies" ;;
    http*) url=${args[i]} ;;
  esac
done
echo "$method $url" >> "$STUB_DIR/curl.requests"
[ "${STUB_CURL_FAIL:-0}" = 1 ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }

path=${url#https://*/}; path=/${path#/}
path=${path#/api/v1}
state="$STUB_DIR/state"; mkdir -p "$state"
reply() { printf '%s\n%s' "$2" "$1"; exit 0; }   # reply <code> <body>

who=""
if [ -n "$hdr" ] && [ -f "$hdr" ]; then
  case "$(cat "$hdr")" in
    *tok-admin*) who=admin ;;
    *tok-reviewer*) who=reviewer ;;
  esac
fi
exists() { # exists <admin|reviewer>: the account is there unless the test removed it and no register came yet
  local v="STUB_NO_${1^^}"
  [ "${!v:-0}" != 1 ] || [ -f "$state/registered-$1" ]
}

doc_gone() { # doc_gone <demo|draft>
  local v="STUB_NO_${1^^}"
  [ "${!v:-0}" = 1 ] && [ ! -f "$state/uploaded-$1" ]
}
shared() { [ "${STUB_DRAFT_SHARED:-0}" = 1 ] && [ ! -f "$state/share-deleted" ]; }

docs_json() { # docs_json <admin|reviewer>
  local items=()
  if [ "$1" = admin ]; then
    doc_gone demo || items+=('{"id":"doc-demo","title":"Demo document","currentVersionId":"ver-demo","role":"owner"}')
    [ "${STUB_DUP_DEMO:-0}" = 1 ] && items+=('{"id":"doc-demo-2","title":"Demo document","currentVersionId":"ver-demo-2","role":"owner"}')
    doc_gone draft || items+=('{"id":"doc-draft","title":"Design review draft","currentVersionId":"ver-draft","role":"owner"}')
  else
    shared && items+=('{"id":"doc-draft","title":"Design review draft","currentVersionId":"ver-draft","role":"viewer"}')
    items+=('{"id":"doc-demo","title":"Demo document","currentVersionId":"ver-demo","role":"commenter"}')
    [ "${STUB_REVIEWER_OWN_DRAFT:-0}" = 1 ] && items+=('{"id":"doc-rev-own","title":"Design review draft","currentVersionId":"ver-rev","role":"owner"}')
  fi
  local joined; joined=$(IFS=,; echo "${items[*]}")
  printf '{"items":[%s],"nextCursor":null}' "$joined"
}

case "$method $path" in
  "GET /") reply "${STUB_GATEWAY_CODE:-200}" '<html></html>' ;;
  "GET /health")
    if [ "${STUB_REDIS_DOWN:-0}" = 1 ]; then
      if [ "${STUB_HEALTH_MULTILINE:-0}" = 1 ]; then reply 503 $'{
  "status": "degraded",
  "postgres": "ok",
  "redis": "down"
}'; fi
      reply 503 '{"status":"degraded","postgres":"ok","redis":"down"}'
    fi
    if [ "${STUB_PG_DOWN:-0}" = 1 ]; then reply 503 '{"status":"degraded","postgres":"down","redis":"ok"}'; fi
    reply 200 '{"status":"ok","postgres":"ok","redis":"ok"}' ;;
  "POST /auth/register")
    [ -z "${STUB_REGISTER_CODE:-}" ] || reply "$STUB_REGISTER_CODE" '{}'
    case "$stdin_body" in
      *admin@contentcollab.app*) if exists admin; then reply 409 '{"error":"Conflict"}'; fi; touch "$state/registered-admin" ;;
      *reviewer@contentcollab.app*) if exists reviewer; then reply 409 '{"error":"Conflict"}'; fi; touch "$state/registered-reviewer" ;;
    esac
    reply 201 '{"id":"user-new","email":"x"}' ;;
  "POST /auth/login")
    [ "${STUB_LOGIN_HTML:-0}" = 1 ] && reply 200 '<html>proxy</html>'
    [ "${STUB_LOGIN_NO_TOKEN:-0}" = 1 ] && reply 200 '{"user":{}}'
    case "$stdin_body" in
      *'"email":"admin@contentcollab.app"'*)
        exists admin && [[ "$stdin_body" == *'"password":"pw-admin-1"'* ]] && reply 200 '{"token":"tok-admin","user":{"id":"user-admin","email":"admin@contentcollab.app"}}' ;;
      *'"email":"reviewer@contentcollab.app"'*)
        exists reviewer && [[ "$stdin_body" == *'"password":"pw-reviewer-1"'* ]] && reply 200 '{"token":"tok-reviewer","user":{"id":"user-reviewer","email":"reviewer@contentcollab.app"}}' ;;
    esac
    reply 401 '{"error":"Unauthorized"}' ;;
  "GET /ops")
    if [ "$who" = admin ]; then [ "${STUB_ADMIN_NOT_OPS:-0}" = 1 ] && reply 403 '{"error":"Forbidden"}'; reply 200 '{"namespace":"contentcollab"}'; fi
    if [ "$who" = reviewer ]; then [ "${STUB_REVIEWER_OPS:-0}" = 1 ] && reply 200 '{"namespace":"contentcollab"}'; reply 403 '{"error":"Forbidden"}'; fi
    reply 401 '{"error":"Unauthorized"}' ;;
  "GET /documents"|"GET /documents?"*) [ -n "$who" ] || reply 401 '{}'; [ -z "${STUB_DOCS_CODE:-}" ] || reply "$STUB_DOCS_CODE" '{}'; reply 200 "$(docs_json "$who")" ;;
  "POST /documents")
    [ "$who" = admin ] || reply 403 '{}'
    case "$title" in
      "Demo document") touch "$state/uploaded-demo"; reply 201 '{"id":"doc-new-1","title":"Demo document","currentVersionId":"ver-new-1","role":"owner"}' ;;
      "Design review draft") touch "$state/uploaded-draft"; reply 201 '{"id":"doc-new-2","title":"Design review draft","currentVersionId":"ver-new-2","role":"owner"}' ;;
    esac
    reply 400 '{}' ;;
  "GET /documents/doc-draft/shares"*|"GET /documents/doc-new-2/shares"*)
    if shared; then reply 200 '{"items":[{"id":"share-1","documentId":"doc-draft","userId":"user-reviewer","role":"viewer"},{"id":"share-0","documentId":"doc-draft","userId":"user-admin","role":"owner"}],"nextCursor":null}'; fi
    reply 200 '{"items":[{"id":"share-0","documentId":"doc-draft","userId":"user-admin","role":"owner"}],"nextCursor":null}' ;;
  "DELETE /documents/doc-draft/shares/share-1") touch "$state/share-deleted"; reply "${STUB_DELETE_CODE:-204}" '' ;;
  "GET /documents/"*"/content") reply "${STUB_CONTENT_CODE:-200}" 'Design review draft, a small text file.' ;;
esac
reply 404 '{"error":"stub: no route"}'
