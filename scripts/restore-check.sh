#!/usr/bin/env bash
# Restore rehearsal for the nightly dump (D30, #50; DB-2, TST-4): fetch the newest dump from Spaces,
# restore it into a scratch database `restore_check` on the cluster's PostgreSQL, print the row count
# of every table in the restored copy beside the live database, then drop the scratch database.
# The live database is only read (counts). The Job's pod uses the same settings and Secret keys as the
# db-backup CronJob. Run it against a cluster you name; the current context is never assumed (INF-20).
#
#   KUBE_CONTEXT=<cluster> bash scripts/restore-check.sh
# Settings: NAMESPACE (contentcollab), TIMEOUT (seconds to wait for the Job, 300).
set -euo pipefail

: "${KUBE_CONTEXT:?set KUBE_CONTEXT to the cluster to check (kubectl config get-contexts)}"
NAMESPACE="${NAMESPACE:-contentcollab}"
TIMEOUT="${TIMEOUT:-300}"
JOB="db-restore-check-$(date -u +%Y%m%d%H%M%S)"

k() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }

# The manifest is quoted so the pod's own variables ($SPACES_BUCKET, $PGDATABASE ...) stay as written
manifest() {
  cat <<'YAML' | sed "s/__JOB__/$JOB/g"
apiVersion: batch/v1
kind: Job
metadata:
  name: __JOB__
  labels:
    app: db-restore-check
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 600
  template:
    metadata:
      labels:
        app: db-restore-check
    spec:
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        fsGroup: 999
      initContainers:
        - name: fetch
          image: amazon/aws-cli:2.41.0
          command: ["sh", "-c"]
          args:
            - |
              set -e
              latest=$(aws s3 ls "s3://$SPACES_BUCKET/backups/" --endpoint-url "$SPACES_ENDPOINT" | awk '{print $4}' | grep '\.dump$' | sort | tail -n 1)
              test -n "$latest" || { echo "no dump under backups/" >&2; exit 1; }
              echo "newest dump: $latest"
              aws s3 cp "s3://$SPACES_BUCKET/backups/$latest" /backup/restore.dump --endpoint-url "$SPACES_ENDPOINT"
          env:
            - {name: HOME, value: /tmp}
            - {name: AWS_ACCESS_KEY_ID, valueFrom: {secretKeyRef: {name: app-secrets, key: SPACES_KEY}}}
            - {name: AWS_SECRET_ACCESS_KEY, valueFrom: {secretKeyRef: {name: app-secrets, key: SPACES_SECRET}}}
            - {name: AWS_DEFAULT_REGION, valueFrom: {configMapKeyRef: {name: app-config, key: SPACES_REGION}}}
            - {name: SPACES_ENDPOINT, valueFrom: {configMapKeyRef: {name: app-config, key: SPACES_ENDPOINT}}}
            - {name: SPACES_BUCKET, valueFrom: {configMapKeyRef: {name: app-config, key: SPACES_BUCKET}}}
            - {name: AWS_REQUEST_CHECKSUM_CALCULATION, value: when_required}
            - {name: AWS_RESPONSE_CHECKSUM_VALIDATION, value: when_required}
          volumeMounts:
            - {name: backup, mountPath: /backup}
          resources:
            requests: {cpu: 50m, memory: 128Mi}
            limits: {cpu: 500m, memory: 256Mi}
      containers:
        - name: restore
          image: postgres:18
          command: ["sh", "-c"]
          args:
            - |
              set -e
              counts() {
                psql -d "$1" -At -c "select table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"
              }
              dropdb --if-exists restore_check
              createdb restore_check
              pg_restore --no-owner --single-transaction --dbname=restore_check /backup/restore.dump
              echo "== restored copy (restore_check)"; counts restore_check
              echo "== live database ($PGDATABASE), read only"; counts "$PGDATABASE"
              dropdb restore_check
              echo "scratch database dropped"
          env:
            - {name: PGHOST, valueFrom: {configMapKeyRef: {name: app-config, key: DB_HOST}}}
            - {name: PGPORT, valueFrom: {configMapKeyRef: {name: app-config, key: DB_PORT}}}
            - {name: PGDATABASE, valueFrom: {configMapKeyRef: {name: app-config, key: DB_NAME}}}
            - {name: PGUSER, valueFrom: {secretKeyRef: {name: app-secrets, key: DB_USER}}}
            - {name: PGPASSWORD, valueFrom: {secretKeyRef: {name: app-secrets, key: DB_PASSWORD}}}
          volumeMounts:
            - {name: backup, mountPath: /backup}
          resources:
            requests: {cpu: 100m, memory: 128Mi}
            limits: {cpu: 500m, memory: 256Mi}
      volumes:
        - name: backup
          emptyDir: {sizeLimit: 1Gi}
YAML
}

echo "context: $KUBE_CONTEXT, namespace: $NAMESPACE, job: $JOB"
manifest | k apply -f -

status=0
k wait --for=condition=complete "job/$JOB" --timeout="${TIMEOUT}s" || status=$?

echo "---- fetch (init container)"
k logs "job/$JOB" -c fetch || true
echo "---- restore"
k logs "job/$JOB" -c restore || true

# The Job is removed either way; a failed run's logs are printed above
k delete "job/$JOB" --wait=false
[ "$status" -eq 0 ] && echo "restore check passed" || { echo "restore check FAILED (kubectl wait exit $status)" >&2; exit 1; }
