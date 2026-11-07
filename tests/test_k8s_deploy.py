"""Checks on the deploy path that need no cluster: image pinning (DEP-12),
rollback on a failed rollout (DEP-13) and the named API port (NET-6).

Run from the repository root:  python3 -m unittest tests.test_k8s_deploy -v
Needs kubectl (for `kubectl kustomize`) and PyYAML. CI runs it in the `k8s` job.
"""

import re
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = (ROOT / ".github" / "workflows" / "deploy.yml").read_text()


def render(overlay):
    out = subprocess.run(
        ["kubectl", "kustomize", f"k8s/{overlay}"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def deployment(docs, name):
    return next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == name)


def containers(docs):
    for d in docs:
        if d["kind"] == "Deployment":
            yield from d["spec"]["template"]["spec"]["containers"]


class ImagePinning(unittest.TestCase):
    def test_no_latest_tag_in_k8s_manifests(self):
        offenders = [
            str(p.relative_to(ROOT))
            for p in (ROOT / "k8s").rglob("*.yaml")
            if re.search(r":latest\b", p.read_text())
        ]
        self.assertEqual(offenders, [], "`:latest` in k8s/ (DEP-12)")

    def test_every_rendered_image_has_an_explicit_tag_other_than_latest(self):
        for overlay in ("minikube", "doks"):
            for c in containers(render(overlay)):
                tag = c["image"].rpartition(":")[2] if ":" in c["image"].rpartition("/")[2] else ""
                self.assertNotIn(tag, ("", "latest"), f"{overlay}: {c['name']} image {c['image']}")

    def test_deploy_pins_the_sha_before_apply(self):
        edit = DEPLOY.find("kustomize edit set image")
        apply = DEPLOY.find("kubectl apply -k k8s/doks")
        self.assertNotEqual(edit, -1, "deploy.yml never runs `kustomize edit set image`")
        self.assertNotEqual(apply, -1, "deploy.yml never runs `kubectl apply -k k8s/doks`")
        self.assertLess(edit, apply, "the SHA must be set before `apply -k` (one rollout)")
        for svc in ("api", "worker"):
            self.assertRegex(DEPLOY, rf"contentcollab-{svc}=.*github\.sha|contentcollab-\$svc=.*github\.sha")

    def test_deploy_has_no_second_rollout_through_set_image(self):
        self.assertNotRegex(DEPLOY, r"kubectl[^\n]* set image", "second rollout after apply")


class RollbackOnFailedRollout(unittest.TestCase):
    def test_each_deployment_is_undone_when_its_rollout_fails(self):
        status = re.search(r"rollout status deployment/(\S+) --timeout=180s\s*\\?\s*\|\|", DEPLOY)
        self.assertIsNotNone(status, "`rollout status ... || ...` missing")
        self.assertRegex(DEPLOY, r"for svc in api worker")
        self.assertIn("rollout undo deployment/$svc", DEPLOY)

    def test_job_still_fails_after_the_undo(self):
        self.assertRegex(DEPLOY, r"exit \$failed", "undo must not turn a failed deploy green")


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
