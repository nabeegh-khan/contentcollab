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


def rollout_step():
    """The rollout step only, so text in other steps cannot satisfy a check."""
    steps = yaml.safe_load(DEPLOY)["jobs"]["rollout"]["steps"]
    return next(s for s in steps if s.get("name") == ROLLOUT_STEP)


def shell_lines(run):
    """The step's shell, one stripped line each, comments removed, so a
    commented-out command cannot satisfy a check."""
    lines = (re.sub(r"(^|\s)#.*$", "", line).strip() for line in run.splitlines())
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
        self.assertRegex(self.body, r"\*:\$\{\{ github\.sha \}\}\) ;;\n\*\) echo [^\n]*; failed=1; continue ;;")

    def test_each_deployment_is_undone_when_its_rollout_fails(self):
        # The command that runs when `rollout status` fails is the undo itself,
        # in the app namespace, followed by marking the run failed
        self.assertRegex(
            self.body,
            r"kubectl -n contentcollab rollout status deployment/\$svc --timeout=180s \\\n"
            r"\|\| \{ kubectl -n contentcollab rollout undo deployment/\$svc \\\n"
            r"\|\| echo [^\n]*; failed=1; \}",
        )

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

    def test_service_target_port_is_the_name(self):
        svc = next(d for d in self.docs if d["kind"] == "Service" and d["metadata"]["name"] == "api")
        self.assertEqual([p["targetPort"] for p in svc["spec"]["ports"]], ["http"])

    def test_both_probes_use_the_name(self):
        self.assertEqual(self.api["readinessProbe"]["httpGet"]["port"], "http")
        self.assertEqual(self.api["livenessProbe"]["tcpSocket"]["port"], "http")


if __name__ == "__main__":
    unittest.main()
