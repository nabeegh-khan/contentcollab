# Stand-in doctl for scripts/do-project.test.mjs: logs its arguments, answers the calls do-project.sh makes.
#   STUB_UNAUTH=1       `doctl account get` fails, as when `doctl auth init` has not been run
#   STUB_PROJECTS=text  what `doctl projects list --format ID,Name --no-header` prints
echo "$*" >> "$STUB_DIR/doctl.argv"
case "$*" in
  "account get"*)
    if [ "${STUB_UNAUTH:-0}" = 1 ]; then echo "Error: Unable to initialize DigitalOcean API client: access token is required" >&2; exit 1; fi
    echo ok ;;
  "projects list"*) printf '%s' "${STUB_PROJECTS:-}" ;;
  "projects create"*) echo "11111111-2222-3333-4444-555555555555" ;;
  *) echo "unexpected doctl call: $*" >&2; exit 2 ;;
esac
