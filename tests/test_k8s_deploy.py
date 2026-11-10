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


def rollout_script():
    """The shell of the rollout step only, so text in other steps cannot satisfy a check."""
    steps = yaml.safe_load(DEPLOY)["jobs"]["rollout"]["steps"]
    return next(s["run"] for s in steps if s.get("name") == ROLLOUT_STEP)


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

    def test_deploy_pins_the_sha_in_doks_before_apply(self):
        run = rollout_script()
        positions = {s: run.find(s) for s in ("cd k8s/doks", "kustomize edit set image", "kubectl apply -k k8s/doks")}
        for text, pos in positions.items():
            self.assertNotEqual(pos, -1, f"rollout step never runs `{text}`")
        self.assertLess(positions["cd k8s/doks"], positions["kustomize edit set image"],
                        "the SHA must be set in the doks overlay")
        self.assertLess(positions["kustomize edit set image"], positions["kubectl apply -k k8s/doks"],
                        "the SHA must be set before `apply -k` (one rollout)")
        self.assertRegex(
            run,
            r"for svc in api worker; do\s+kustomize edit set image "
            r"\S*contentcollab-\$svc=\S*contentcollab-\$svc:\$\{\{ github\.sha \}\}\s",
            "both images must be pinned to this commit",
        )

    def test_deploy_has_no_second_rollout_through_set_image(self):
        self.assertNotRegex(DEPLOY, r"kubectl[^\n]* set image", "second rollout after apply")


class RollbackOnFailedRollout(unittest.TestCase):
    def setUp(self):
        self.script = rollout_script()
        # What runs when `rollout status` fails: the `|| { ... }` right after
        # it, inside the loop over both Deployments
        self.on_failure = re.search(
            r"for svc in api worker; do.*?rollout status deployment/\$svc --timeout=180s\s*\\?\s*\|\|\s*\{(.*?)\}\s*\n\s*done",
            self.script, re.S)

    def test_each_deployment_is_undone_when_its_rollout_fails(self):
        self.assertIsNotNone(self.on_failure, "`rollout status deployment/$svc ... || { ... }` over api and worker missing")
        self.assertIn("rollout undo deployment/$svc", self.on_failure.group(1))

    def test_job_still_fails_after_the_undo(self):
        self.assertIsNotNone(self.on_failure, "`rollout status ... || { ... }` missing")
        self.assertIn("failed=1", self.on_failure.group(1), "a failed rollout must mark the run failed")
        self.assertTrue(self.script.rstrip().endswith("exit $failed"), "undo must not turn a failed deploy green")


class NamedApiPort(unittest.TestCase):
    def setUp(self):
        self.docs = render("doks")
        self.api = next(c for c in deployment(self.docs, "api")["spec"]["template"]["spec"]["containers"])

    def test_container_port_is_named_http(self):
        self.assertIn({"name": "http", "containerPort": 3000}, self.api["ports"])

    def test_service_target_port_is_the_name(self):
        svc = next(d for d in self.docs if d["kind"] == "Service" and d["metadata"]["name"] == "api")
        self.assertEqual([p["targetPort"] for p in svc["spec"]["ports"]], ["http"])

    def test_both_probes_use_the_name(self):
        self.assertEqual(self.api["readinessProbe"]["httpGet"]["port"], "http")
        self.assertEqual(self.api["livenessProbe"]["tcpSocket"]["port"], "http")


if __name__ == "__main__":
    unittest.main()
