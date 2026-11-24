# Stand-in kubectl for scripts/demo-preflight.test.mjs (#174): the pods and the api autoscaler of a namespace shaped like the live one.
# shellcheck shell=bash
# Logs its arguments to $STUB_DIR/kubectl.argv and
# answers `get pods -o json` and `get hpa api -o json` with a namespace shaped like the live one.
#   STUB_POD_NOT_READY=<pod>   that pod is Running but not Ready
#   STUB_NO_POD=<component>    no pod for that component (api, web, worker, postgres, redis, gateway)
#   STUB_NO_HPA=1              the api autoscaler does not exist
echo "$*" >> "$STUB_DIR/kubectl.argv"

pod() { # name phase ready
  printf '{"metadata":{"name":"%s"},"status":{"phase":"%s","containerStatuses":[{"ready":%s}]}}' "$1" "$2" "$3"
}
ready_of() { if [ "${STUB_POD_NOT_READY:-}" = "$1" ]; then echo false; else echo true; fi; }

case "$*" in
  *"get pods -o json"*)
    names="api-776479cdf7-cghmn api-776479cdf7-hccxk web-7fd78bcf9d-hfblz web-7fd78bcf9d-zngmd worker-66676dcf49-pm9z2 postgres-0 redis-5495d876dd-fv2dd contentcollab-nginx-895f84697-95xhm"
    out=""
    for n in $names; do
      comp=${n%%-*}; [ "$comp" = contentcollab ] && comp=gateway
      [ "${STUB_NO_POD:-}" = "$comp" ] && continue
      out="${out:+$out,}$(pod "$n" Running "$(ready_of "$n")")"
    done
    out="$out,$(pod db-migrate-042f43fdaaab1011b2e367bf424b022d80149f67-b4rvw Succeeded false)"
    printf '{"items":[%s]}\n' "$out" ;;
  *"get hpa api -o json"*)
    if [ "${STUB_NO_HPA:-0}" = 1 ]; then echo 'Error from server (NotFound): horizontalpodautoscalers.autoscaling "api" not found' >&2; exit 1; fi
    echo '{"spec":{"minReplicas":2,"maxReplicas":5},"status":{"currentReplicas":2}}' ;;
  *) : ;;
esac
exit 0
