"""Checks on the deploy path that need no cluster: image pinning and
rollback on a failed rollout (INF-9) and the named API port (INF-10).

Run from the repository root:  python3 -m unittest tests.test_k8s_deploy -v
Needs kubectl (for `kubectl kustomize`) and PyYAML. CI runs it in the `k8s` job.
DEPLOY_WORKFLOW points the workflow checks at another copy of deploy.yml
(used to show they fail when the rollout step is broken).
"""

import os
import re
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = Path(os.environ.get("DEPLOY_WORKFLOW", ROOT / ".github" / "workflows" / "deploy.yml")).read_text()
ROLLOUT_STEP = "Roll the Deployments to this commit"


SMOKE_STEP = "Smoke check, roll back on failure"


def jobs():
    return yaml.safe_load(DEPLOY)["jobs"]


def step(name):
    """One step of the rollout job, so text in other steps cannot satisfy a check."""
    return next(s for s in jobs()["rollout"]["steps"] if s.get("name") == name)


def rollout_step():
    return step(ROLLOUT_STEP)


def shell_lines(run):
    """The step's shell, one line each: comments removed, so a commented-out
    command cannot satisfy a check; double quotes dropped and spaces collapsed,
    so quoting a variable does not break one."""
    lines = (" ".join(re.sub(r"(^|\s)#.*$", "", line).replace('"', "").split()) for line in run.splitlines())
    return [line for line in lines if line]


def loops(lines):
    """(word list, body lines, index after `done`) of each `for svc in ...; do ... done`."""
    found, i = [], 0
    while i < len(lines):
        m = re.fullmatch(r"for svc in (.+); do", lines[i])
        if m:
            end = lines.index("done", i)
            found.append((m.group(1), lines[i + 1:end], end + 1))
            i = end
        i += 1
    return found


def render(overlay):
    out = subprocess.run(
        ["kubectl", "kustomize", f"k8s/{overlay}"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def deployment(docs, name):
    return next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == name)


POD_TEMPLATE = {
    "Deployment": ("spec", "template"),
    "StatefulSet": ("spec", "template"),
    "DaemonSet": ("spec", "template"),
    "Job": ("spec", "template"),
    "CronJob": ("spec", "jobTemplate", "spec", "template"),
}


def containers(docs):
    """Every container and init container of every workload kind that runs pods."""
    for d in docs:
        path = POD_TEMPLATE.get(d["kind"])
        if path is None:
            continue
        template = d
        for key in path:
            template = template[key]
        yield from template["spec"].get("initContainers", [])
        yield from template["spec"]["containers"]


class ImagePinning(unittest.TestCase):
    def test_no_latest_tag_in_k8s_manifests(self):
        offenders = [
            str(p.relative_to(ROOT))
            for p in (ROOT / "k8s").rglob("*.yaml")
            if re.search(r":latest\b", p.read_text())
        ]
        self.assertEqual(offenders, [], "`:latest` in k8s/ (INF-9)")

    def test_every_rendered_image_has_an_explicit_tag_other_than_latest(self):
        for overlay in ("minikube", "doks"):
            for c in containers(render(overlay)):
                tag = c["image"].rpartition(":")[2] if ":" in c["image"].rpartition("/")[2] else ""
                self.assertNotIn(tag, ("", "latest"), f"{overlay}: {c['name']} image {c['image']}")

    def test_rollout_follows_the_checks_and_the_build(self):
        self.assertEqual(jobs()["build"].get("needs"), "checks")
        self.assertEqual(jobs()["rollout"].get("needs"), "build")
        self.assertNotIn("if", jobs()["rollout"], "the rollout job must not be skipped")
        # A cancelled run would stop between the apply and the undo
        self.assertIs(jobs()["rollout"]["concurrency"]["cancel-in-progress"], False)

    def test_rollout_step_runs_whenever_the_cluster_exists(self):
        step = rollout_step()
        self.assertEqual(step.get("if"), "steps.cluster.outputs.present == 'true'")
        self.assertNotIn("continue-on-error", step, "a failed rollout must fail the job")

    def test_deploy_pins_the_sha_in_doks_before_apply(self):
        lines = shell_lines(rollout_step()["run"])
        # The only directory changes and the only apply: into doks, back, apply doks once
        self.assertEqual([l for l in lines if l.startswith("cd ")], ["cd k8s/doks", "cd ../.."])
        self.assertEqual([l for l in lines if "kubectl apply" in l], ["kubectl apply -k k8s/doks"])
        pins = [(words, body, after) for words, body, after in loops(lines)
                if any("kustomize edit set image" in b for b in body)]
        self.assertEqual(len(pins), 1, "one pin loop")
        words, body, after = pins[0]
        self.assertEqual(words, "api worker", "both images must be pinned")
        self.assertEqual(body, ["kustomize edit set image "
                                "$REGISTRY/contentcollab-$svc=$REGISTRY/contentcollab-$svc:${{ github.sha }}"])
        start = after - len(body) - 2  # index of the `for` line
        self.assertLess(lines.index("cd k8s/doks"), start, "the SHA must be set in the doks overlay")
        self.assertLess(after, lines.index("kubectl apply -k k8s/doks"),
                        "the SHA must be set before `apply -k` (one rollout)")

    def test_deploy_has_no_second_rollout_through_set_image(self):
        self.assertNotRegex(DEPLOY, r"kubectl[^\n]* set image", "second rollout after apply")


class RollbackOnFailedRollout(unittest.TestCase):
    def setUp(self):
        self.lines = shell_lines(rollout_step()["run"])
        watch = [(words, body, after) for words, body, after in loops(self.lines)
                 if any("rollout status" in b for b in body)]
        self.assertEqual(len(watch), 1, "one loop that watches the rollouts")
        self.words, body, self.after = watch[0]
        self.body = "\n".join(body)

    def test_both_deployments_are_watched(self):
        self.assertEqual(self.words, "api worker")
        # A Deployment not running this commit's image fails the run
        self.assertRegex(self.body, r"\*:\$\{\{ github\.sha \}\}\) ;;\n(?:[^\n]*\n)*?\*\) echo [^\n]*; failed=1; continue ;;\nesac")

    def test_each_deployment_is_undone_when_its_rollout_fails(self):
        # The command that runs when `rollout status` fails is the undo itself,
        # in the app namespace, followed by marking the run failed
        self.assertRegex(
            self.body,
            r"kubectl -n contentcollab rollout status deployment/\$svc --timeout=180s \\\n"
            r"\|\| \{ kubectl -n contentcollab rollout undo deployment/\$svc \\\n"
            r"\|\| echo [^\n]*; failed=1; \}",
        )

    def test_a_deployment_left_on_the_placeholder_is_undone(self):
        # A pin that matched nothing applies `unpinned`, which cannot be
        # pulled: the run fails, and the branch falls through to the watch,
        # whose `rollout status` waits for the new revision before the undo
        # (an undo straight after the apply could go one revision too far)
        branch = re.search(r"\*:unpinned\) ([^\n]*(?:\n(?!\*\))[^\n]*)*?;;)", self.body)
        self.assertIsNotNone(branch, "no case for the placeholder tag")
        self.assertRegex(branch.group(1), r"failed=1 ;;$")
        self.assertNotIn("continue", branch.group(1))
        self.assertNotIn("rollout undo", branch.group(1))

    def test_smoke_failure_fails_the_run(self):
        self.assertEqual(shell_lines(step(SMOKE_STEP)["run"])[-1], "exit 1")

    def test_job_still_fails_after_the_undo(self):
        self.assertEqual(self.lines[self.after:], ["exit $failed"], "undo must not turn a failed deploy green")
        self.assertEqual([l for l in self.lines if re.match(r"failed=0\b", l)], ["failed=0"])
        self.assertLess(self.lines.index("failed=0"), self.after - 1)


class NamedApiPort(unittest.TestCase):
    def setUp(self):
        self.docs = render("doks")
        self.api = next(c for c in deployment(self.docs, "api")["spec"]["template"]["spec"]["containers"])

    def test_container_port_is_named_http(self):
        self.assertIn({"name": "http", "containerPort": 3000}, self.api["ports"])

    def test_service_target_port_is_the_number_of_the_named_port(self):
        # Not the name yet: the pods running on the cluster have an unnamed
        # port, and a Service that switches to targetPort `http` in the same
        # apply moves them to an EndpointSlice with no ports before any new
        # pod is ready, so the API has no routable endpoint for that window
        # (seen on k3s 1.34, 11 Nov). The name follows once named pods run.
        svc = next(d for d in self.docs if d["kind"] == "Service" and d["metadata"]["name"] == "api")
        named = next(p["containerPort"] for p in self.api["ports"] if p.get("name") == "http")
        self.assertEqual([p["targetPort"] for p in svc["spec"]["ports"]], [named])

    def test_both_probes_use_the_name(self):
        self.assertEqual(self.api["readinessProbe"]["httpGet"]["port"], "http")
        self.assertEqual(self.api["livenessProbe"]["tcpSocket"]["port"], "http")


MIGRATE_STEP = "Migrate the database to this commit"
CREDENTIALS_STEP = "Short-lived cluster credentials"
JOB_FILE = ROOT / "k8s" / "doks" / "migrate-job.yaml"
JOB_NAME = "db-migrate-${{ github.sha }}"


def step_names():
    return [s.get("name") for s in jobs()["rollout"]["steps"]]


def keys_of(path, section):
    """Top-level keys of a ConfigMap's `data` or a Secret's `stringData`."""
    doc = yaml.safe_load((ROOT / path).read_text())
    return set(doc[section])


class MigrationJob(unittest.TestCase):
    """D20 (#117): the Job that runs api/migrations before each rollout."""

    def setUp(self):
        self.text = JOB_FILE.read_text()
        self.job = yaml.safe_load(self.text)
        self.pod = self.job["spec"]["template"]["spec"]
        self.c = self.pod["containers"][0]

    def test_one_job_per_commit_in_the_app_namespace(self):
        self.assertEqual(self.job["kind"], "Job")
        self.assertEqual(self.job["metadata"]["name"], "db-migrate-__IMAGE_TAG__")
        self.assertEqual(self.job["metadata"]["namespace"], "contentcollab")

    def test_runs_the_api_image_of_this_commit(self):
        self.assertEqual(self.c["image"], "ghcr.io/nabeegh-khan/contentcollab-api:__IMAGE_TAG__")
        self.assertEqual(self.c["command"], ["npm", "run", "migrate", "--", "up"])
        # deploy.yml fills only __IMAGE_TAG__; any other placeholder would
        # reach the cluster as text
        self.assertEqual(set(re.findall(r"__[A-Z][A-Z0-9_]*__", self.text)), {"__IMAGE_TAG__"})

    def test_no_blind_retry_a_deadline_and_a_kept_log(self):
        spec = self.job["spec"]
        self.assertEqual(spec["backoffLimit"], 0)
        self.assertEqual(spec["activeDeadlineSeconds"], 120)
        self.assertEqual(spec["ttlSecondsAfterFinished"], 86400)
        self.assertEqual(self.pod["restartPolicy"], "Never")

    def test_non_root_with_requests_and_limits(self):
        self.assertEqual(self.pod["securityContext"], {"runAsNonRoot": True, "runAsUser": 1000})
        for kind in ("requests", "limits"):
            self.assertEqual(set(self.c["resources"][kind]), {"cpu", "memory"}, kind)

    def test_connection_only_from_the_database_keys_that_exist(self):
        # No envFrom: the Job gets the five values it needs, not the signing
        # key or the Spaces credentials (SEC-2)
        self.assertNotIn("envFrom", self.c)
        env = {e["name"]: e["valueFrom"] for e in self.c["env"]}
        self.assertEqual(set(env), {"PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"})
        config = keys_of("k8s/base/configmap.yaml", "data")
        stored = keys_of("k8s/base/secrets.example.yaml", "stringData")
        expected = {"PGHOST": ("configMapKeyRef", "app-config", "DB_HOST"),
                    "PGPORT": ("configMapKeyRef", "app-config", "DB_PORT"),
                    "PGDATABASE": ("configMapKeyRef", "app-config", "DB_NAME"),
                    "PGUSER": ("secretKeyRef", "app-secrets", "DB_USER"),
                    "PGPASSWORD": ("secretKeyRef", "app-secrets", "DB_PASSWORD")}
        for var, (ref, name, key) in expected.items():
            self.assertEqual(env[var], {ref: {"name": name, "key": key}}, var)
            self.assertIn(key, config if ref == "configMapKeyRef" else stored, var)

    def test_the_overlay_does_not_apply_the_job(self):
        # Applied only by the migrate step, with the tag filled in
        self.assertEqual([d for d in render("doks") if d["kind"] == "Job"], [])


class MigrateBeforeRollout(unittest.TestCase):
    def setUp(self):
        self.step = step(MIGRATE_STEP)
        self.lines = shell_lines(self.step["run"])

    def test_between_the_credentials_and_the_rollout(self):
        names = step_names()
        self.assertEqual(names.index(MIGRATE_STEP), names.index(CREDENTIALS_STEP) + 1)
        self.assertEqual(names.index(ROLLOUT_STEP), names.index(MIGRATE_STEP) + 1)

    def test_runs_whenever_the_cluster_exists_and_its_failure_stops_the_run(self):
        self.assertEqual(self.step.get("if"), "steps.cluster.outputs.present == 'true'")
        self.assertNotIn("continue-on-error", self.step)
        # The rollout keeps the default condition, so it is skipped after a
        # failed migration and the old pods keep serving
        self.assertNotIn("always()", rollout_step().get("if", ""))

    def test_skipped_while_there_are_no_migrations(self):
        guard = self.lines[0]
        self.assertRegex(guard, r"^if \[ ! -d api/migrations \]; then echo .*; exit 0; fi$")

    def test_old_job_of_this_commit_is_deleted_before_the_apply(self):
        delete = f"kubectl -n contentcollab delete job {JOB_NAME} --ignore-not-found --wait=true"
        apply = ("sed s/__IMAGE_TAG__/${{ github.sha }}/g k8s/doks/migrate-job.yaml "
                 "| kubectl apply -f -")
        self.assertIn(delete, self.lines)
        self.assertIn(apply, self.lines)
        self.assertLess(self.lines.index(delete), self.lines.index(apply))

    def test_waits_for_completion_and_fails_with_the_log(self):
        wait = (f"if ! kubectl -n contentcollab wait --for=condition=complete job/{JOB_NAME} "
                "--timeout=150s; then")
        self.assertIn(wait, self.lines)
        rest = self.lines[self.lines.index(wait) + 1:]
        self.assertIn(f"kubectl -n contentcollab logs job/{JOB_NAME} --tail=100 || true", rest)
        self.assertEqual(rest[rest.index("fi") - 1], "exit 1")

    def test_inside_the_ten_minute_credential(self):
        # D20: migrate wait plus both rollouts, under the 600 s credential
        # with a minute to spare (the smoke check fetches fresh credentials)
        migrate = [int(t) for t in re.findall(r"--timeout=(\d+)s", self.step["run"])]
        rollout = [int(t) for t in re.findall(r"rollout status [^\n]*--timeout=(\d+)s", rollout_step()["run"])]
        self.assertEqual(len(migrate), 1, "one wait in the migrate step")
        self.assertEqual(len(rollout), 1, "one rollout wait, run once per Deployment")
        self.assertLessEqual(migrate[0] + 2 * rollout[0], 540)


if __name__ == "__main__":
    unittest.main()
