"""The nightly pg_dump CronJob and its restore runbook (D30, #50; INF-4, SEC-1, SEC-2, SEC-6, CON-1, CON-3, INF-9).

Run from the repository root:  python3 -m unittest tests.test_backup_cronjob -v
Needs kubectl (for `kubectl kustomize`) and PyYAML. CI runs it in the `k8s` job.
"""

import re
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
LOGIN_FIELDS = {"DB_USER", "DB_PASSWORD"}
SPACES_FIELDS = {"SPACES_KEY", "SPACES_SECRET"}


def render(overlay):
    out = subprocess.run(
        ["kubectl", "kustomize", f"k8s/{overlay}"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def secret_keys(container):
    """The keys a container reads from the Secret, by environment variable."""
    return {
        e["valueFrom"]["secretKeyRef"]["key"]
        for e in container.get("env", [])
        if "secretKeyRef" in e.get("valueFrom", {})
    }


def major(image):
    return re.fullmatch(r".+:(\d+)(?:\.\d+)*(?:-.+)?", image).group(1)


class BackupCronJob(unittest.TestCase):
    def setUp(self):
        self.docs = render("doks")
        [self.cron] = [d for d in self.docs if d["kind"] == "CronJob" and d["metadata"]["name"] == "db-backup"]
        self.spec = self.cron["spec"]
        self.pod = self.spec["jobTemplate"]["spec"]["template"]["spec"]
        [self.dump] = self.pod["initContainers"]
        [self.upload] = self.pod["containers"]
        self.postgres = next(
            d for d in self.docs if d["kind"] == "StatefulSet" and d["metadata"]["name"] == "postgres"
        )["spec"]["template"]["spec"]["containers"][0]

    def test_runs_nightly_in_a_named_time_zone_and_never_twice_at_once(self):
        self.assertRegex(self.spec["schedule"], r"^\d+ \d+ \* \* \*$")
        self.assertEqual(self.spec["timeZone"], "America/Toronto")
        self.assertEqual(self.spec["concurrencyPolicy"], "Forbid")
        self.assertLessEqual(self.spec["startingDeadlineSeconds"], 3600)

    def test_history_and_retries_are_bounded(self):
        self.assertEqual(self.spec["successfulJobsHistoryLimit"], 3)
        self.assertEqual(self.spec["failedJobsHistoryLimit"], 1)
        self.assertEqual(self.spec["jobTemplate"]["spec"]["backoffLimit"], 1)
        self.assertIn("activeDeadlineSeconds", self.spec["jobTemplate"]["spec"])

    def test_one_container_per_job_dump_first_then_upload(self):
        self.assertEqual(self.dump["name"], "dump")
        self.assertEqual(self.upload["name"], "upload")
        self.assertEqual(self.pod["restartPolicy"], "Never")

    def test_images_are_pinned_and_the_dump_client_is_not_older_than_the_server(self):
        for c in (self.dump, self.upload):
            self.assertNotIn(":latest", c["image"])
            self.assertRegex(c["image"], r":\d")
        # pg_dump refuses a server newer than itself
        self.assertGreaterEqual(int(major(self.dump["image"])), int(major(self.postgres["image"])))

    def test_dump_is_a_custom_format_archive_written_to_the_shared_volume(self):
        text = " ".join(self.dump["command"] + self.dump.get("args", []))
        self.assertIn("pg_dump", text)
        self.assertRegex(text, r"--format=custom|-Fc")
        self.assertIn("/backup/", text)
        mounts = {m["mountPath"] for m in self.dump["volumeMounts"]} & {m["mountPath"] for m in self.upload["volumeMounts"]}
        self.assertEqual(mounts, {"/backup"})
        self.assertTrue(any("emptyDir" in v for v in self.pod["volumes"]))

    def test_dump_stops_the_pod_on_failure_so_nothing_empty_is_uploaded(self):
        text = " ".join(self.dump["command"] + self.dump.get("args", []))
        self.assertNotIn("||", text)
        self.assertNotIn("; true", text)
        self.assertNotIn("set +e", text)

    def test_upload_goes_to_the_backups_prefix_of_the_spaces_endpoint(self):
        text = " ".join(self.upload["command"] + self.upload.get("args", []))
        self.assertIn("aws s3 cp", text)
        self.assertIn('--endpoint-url "$SPACES_ENDPOINT"', text)
        self.assertRegex(text, r's3://\$SPACES_BUCKET/backups/')

    def test_checksum_settings_keep_the_cli_compatible_with_spaces(self):
        env = {e["name"]: e.get("value") for e in self.upload["env"]}
        self.assertEqual(env["AWS_REQUEST_CHECKSUM_CALCULATION"], "when_required")
        self.assertEqual(env["AWS_RESPONSE_CHECKSUM_VALIDATION"], "when_required")

    def test_each_container_gets_only_its_own_keys_from_the_secret(self):
        # SEC-2: the dump never sees the Spaces keys and the upload never sees the database login
        self.assertEqual(secret_keys(self.dump), LOGIN_FIELDS)
        self.assertEqual(secret_keys(self.upload), SPACES_FIELDS)

    def test_nothing_is_written_into_the_manifest(self):
        # SEC-1: every credential is a reference
        for c in (self.dump, self.upload):
            for e in c.get("env", []):
                if e["name"] in {"PGPASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}:
                    self.assertNotIn("value", e, e["name"])
                    self.assertIn("secretKeyRef", e["valueFrom"], e["name"])

    def test_settings_come_from_the_app_config(self):
        refs = {
            e["valueFrom"]["configMapKeyRef"]["key"]
            for c in (self.dump, self.upload)
            for e in c.get("env", [])
            if "configMapKeyRef" in e.get("valueFrom", {})
        }
        self.assertTrue({"DB_HOST", "DB_PORT", "DB_NAME", "SPACES_ENDPOINT", "SPACES_BUCKET", "SPACES_REGION"} <= refs)

    def test_runs_as_non_root_with_requests_and_limits(self):
        self.assertTrue(self.pod["securityContext"]["runAsNonRoot"])
        for c in (self.dump, self.upload):
            for kind in ("requests", "limits"):
                self.assertEqual(set(c["resources"][kind]), {"cpu", "memory"}, f'{c["name"]} {kind}')

    def test_the_minikube_overlay_carries_it_too_because_it_lives_in_the_base(self):
        self.assertEqual([d["metadata"]["name"] for d in render("minikube") if d["kind"] == "CronJob"], ["db-backup"])

    def test_the_cronjob_is_in_the_app_namespace(self):
        self.assertEqual(self.cron["metadata"]["namespace"], "contentcollab")


SCRIPT = ROOT / "scripts" / "restore-check.sh"


class RestoreCheckScript(unittest.TestCase):
    def run_script(self, env):
        return subprocess.run(["bash", "scripts/restore-check.sh"], cwd=ROOT, capture_output=True, text=True, env=env)

    def test_parses(self):
        self.assertEqual(subprocess.run(["bash", "-n", "scripts/restore-check.sh"], cwd=ROOT).returncode, 0)

    def test_refuses_to_run_without_a_named_cluster_and_calls_no_kubectl(self):
        import os, tempfile

        with tempfile.TemporaryDirectory() as tmp:
            stub = Path(tmp) / "kubectl"
            stub.write_text("#!/bin/sh\necho called >> \"$0.log\"\n")
            stub.chmod(0o755)
            env = {k: v for k, v in os.environ.items() if k != "KUBE_CONTEXT"}
            env["PATH"] = f"{tmp}{os.pathsep}{env['PATH']}"
            result = self.run_script(env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("KUBE_CONTEXT", result.stderr)
            self.assertFalse((Path(tmp) / "kubectl.log").exists())

    def test_the_scratch_database_is_dropped_and_the_job_removed_on_every_path(self):
        text = SCRIPT.read_text()
        self.assertIn("dropdb restore_check", text)
        self.assertIn('k delete "job/$JOB"', text)
        # the live database is only counted, never restored into
        self.assertNotIn("--clean", text)
        self.assertIn("--dbname=restore_check", text)

    def test_images_are_pinned(self):
        for image in re.findall(r"image: (\S+)", SCRIPT.read_text()):
            self.assertRegex(image, r":\d")


class RestoreRunbook(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / "docs" / "RUNBOOK.md").read_text()

    def test_has_the_four_sections(self):
        for heading in ("## Back up now", "## Find a dump", "## Restore into a scratch database", "## Restore the live database"):
            self.assertIn(heading, self.text)

    def test_restores_into_a_scratch_database_before_the_live_one_with_the_documented_flags(self):
        self.assertLess(self.text.index("## Restore into a scratch database"), self.text.index("## Restore the live database"))
        for flag in ("--clean", "--if-exists", "--no-owner", "--single-transaction"):
            self.assertIn(flag, self.text)

    def test_sets_the_lifecycle_rule_that_expires_old_dumps(self):
        self.assertIn("put-bucket-lifecycle-configuration", self.text)
        self.assertIn("backups/", self.text)

    def test_every_command_names_the_cluster_context(self):
        for line in self.text.splitlines():
            if re.match(r"\s*(kubectl|\$env:KUBE)", line) and "kubectl" in line:
                self.assertIn("--context", line, line)


if __name__ == "__main__":
    unittest.main()
