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
    doc_gone draft || items+=('{"id":"doc-draft","title":"Design review draft","currentVersionId":"ver-draft","role":"owner"}')
  else
    shared && items+=('{"id":"doc-draft","title":"Design review draft","currentVersionId":"ver-draft","role":"viewer"}')
    items+=('{"id":"doc-demo","title":"Demo document","currentVersionId":"ver-demo","role":"commenter"}')
  fi
  local joined; joined=$(IFS=,; echo "${items[*]}")
  printf '{"items":[%s],"nextCursor":null}' "$joined"
}

case "$method $path" in
  "GET /") reply "${STUB_GATEWAY_CODE:-200}" '<html></html>' ;;
  "GET /health")
    if [ "${STUB_REDIS_DOWN:-0}" = 1 ]; then reply 503 '{"status":"degraded","postgres":"ok","redis":"down"}'; fi
    if [ "${STUB_PG_DOWN:-0}" = 1 ]; then reply 503 '{"status":"degraded","postgres":"down","redis":"ok"}'; fi
    reply 200 '{"status":"ok","postgres":"ok","redis":"ok"}' ;;
  "POST /auth/register")
    case "$stdin_body" in
      *admin@contentcollab.app*) if exists admin; then reply 409 '{"error":"Conflict"}'; fi; touch "$state/registered-admin" ;;
      *reviewer@contentcollab.app*) if exists reviewer; then reply 409 '{"error":"Conflict"}'; fi; touch "$state/registered-reviewer" ;;
    esac
    reply 201 '{"id":"user-new","email":"x"}' ;;
  "POST /auth/login")
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
  "GET /documents"|"GET /documents?"*) [ -n "$who" ] || reply 401 '{}'; reply 200 "$(docs_json "$who")" ;;
  "POST /documents")
    [ "$who" = admin ] || reply 403 '{}'
    case "$title" in
      "Demo document") touch "$state/uploaded-demo"; reply 201 '{"id":"doc-new-1","title":"Demo document","currentVersionId":"ver-new-1","role":"owner"}' ;;
      "Design review draft") touch "$state/uploaded-draft"; reply 201 '{"id":"doc-new-2","title":"Design review draft","currentVersionId":"ver-new-2","role":"owner"}' ;;
    esac
    reply 400 '{}' ;;
  "GET /documents/doc-draft/shares"|"GET /documents/doc-new-2/shares")
    if shared; then reply 200 '{"items":[{"id":"share-1","documentId":"doc-draft","userId":"user-reviewer","role":"viewer"},{"id":"share-0","documentId":"doc-draft","userId":"user-admin","role":"owner"}],"nextCursor":null}'; fi
    reply 200 '{"items":[{"id":"share-0","documentId":"doc-draft","userId":"user-admin","role":"owner"}],"nextCursor":null}' ;;
  "DELETE /documents/doc-draft/shares/share-1") touch "$state/share-deleted"; reply 204 '' ;;
  "GET /documents/"*"/content") reply "${STUB_CONTENT_CODE:-200}" 'Design review draft, a small text file.' ;;
esac
reply 404 '{"error":"stub: no route"}'
