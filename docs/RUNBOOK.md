# Runbook: database backup and restore

The database is dumped every night at 03:00 (America/Toronto) by the `db-backup` CronJob (D30, #50)
to `s3://contentcollab/backups/contentcollab-<UTC timestamp>.dump` in Spaces. A dump is a
`pg_dump --format=custom` archive. Commands are for Windows PowerShell 5.1, one per line. The
cluster is `do-nyc3-contentcollab`.

## Back up now

Run the CronJob once outside its schedule. Use a new job name each time.

```powershell
kubectl --context do-nyc3-contentcollab -n contentcollab create job --from=cronjob/db-backup db-backup-manual-1
kubectl --context do-nyc3-contentcollab -n contentcollab wait --for=condition=complete job/db-backup-manual-1 --timeout=300s
kubectl --context do-nyc3-contentcollab -n contentcollab logs job/db-backup-manual-1 -c dump
kubectl --context do-nyc3-contentcollab -n contentcollab logs job/db-backup-manual-1 -c upload
kubectl --context do-nyc3-contentcollab -n contentcollab delete job/db-backup-manual-1
```

The `dump` log lists the file with its size. If the dump step fails, the pod stops there and nothing is
uploaded. See the last scheduled runs with `kubectl --context do-nyc3-contentcollab -n contentcollab get jobs -l app=db-backup`.

## Find a dump

The restore check below picks the newest dump by name (the timestamp sorts). To list the dumps yourself,
type your own Spaces key and secret into the session first (never into a file), then:

```powershell
$env:AWS_ACCESS_KEY_ID = "<typed by you>"
$env:AWS_SECRET_ACCESS_KEY = "<typed by you>"
$env:AWS_DEFAULT_REGION = "tor1"
$env:AWS_REQUEST_CHECKSUM_CALCULATION = "when_required"
$env:AWS_RESPONSE_CHECKSUM_VALIDATION = "when_required"
aws s3 ls s3://contentcollab/backups/ --endpoint-url https://tor1.digitaloceanspaces.com
```

Dumps expire after 14 days by a Spaces lifecycle rule, set once (needs `lifecycle.json` beside you):

```json
{"Rules": [{"ID": "expire-backups", "Status": "Enabled", "Filter": {"Prefix": "backups/"}, "Expiration": {"Days": 14}}]}
```

```powershell
aws s3api put-bucket-lifecycle-configuration --bucket contentcollab --lifecycle-configuration file://lifecycle.json --endpoint-url https://tor1.digitaloceanspaces.com
```

## Restore into a scratch database

This is the rehearsal, and the first step of any real restore. It does not touch the live data: it
restores the newest dump into a scratch database `restore_check`, prints the row count of every table
in the copy next to the live database, and drops the scratch database.

```powershell
$env:KUBE_CONTEXT = "do-nyc3-contentcollab"
& "C:\Program Files\Git\bin\bash.exe" scripts\restore-check.sh
```

A pass ends with `restore check passed`. Compare the two lists: a table that is missing, or a count in
the copy far from the live one, means the dump is not usable. Output of the rehearsal of 21 November is
in `docs/evidence/`.

## Restore the live database

Not rehearsed on the cluster: only the scratch restore above was. Do it only after the scratch restore
passed on the same dump, and tell the team first, because the site is down for the length of the restore.

1. Stop the writers so nothing is written during the restore:

```powershell
kubectl --context do-nyc3-contentcollab -n contentcollab scale deployment/api deployment/worker --replicas=0
```

2. Run `pg_restore` from a pod that has the dump and the database login, with the same flags as the
   scratch restore plus the ones that replace what is there: `--clean --if-exists --no-owner --single-transaction`
   and `--dbname=contentcollab`. `--single-transaction` rolls everything back if one statement fails, so a
   failed restore leaves the database as it was.
3. Scale the writers back to what the HPA and the Deployment expect, and check `/health`:

```powershell
kubectl --context do-nyc3-contentcollab -n contentcollab scale deployment/api --replicas=2
kubectl --context do-nyc3-contentcollab -n contentcollab scale deployment/worker --replicas=1
```

The Deployment's own `replicas` field is applied again by the next deploy, so these two numbers are the
ones in `k8s/base`. A restored database is at the schema version of the dump: if the dump is older than
the deployed migrations, run the migration Job for the deployed commit before scaling the api up.
