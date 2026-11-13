"""The API may read its own Deployment for the status page (#30, ARCHITECTURE D23), and nothing else.

Run from the repository root:  python3 -m unittest tests.test_k8s_status_rbac -v
Needs kubectl (for `kubectl kustomize`) and PyYAML; CI runs it in the `k8s` job.
"""

import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def render(overlay):
    out = subprocess.run(
        ["kubectl", "kustomize", f"k8s/{overlay}"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def one(docs, kind, name):
    found = [d for d in docs if d["kind"] == kind and d["metadata"]["name"] == name]
    assert len(found) == 1, f"{kind}/{name}: {len(found)} found"
    return found[0]


class StatusReadAccess(unittest.TestCase):
    def setUp(self):
        self.docs = render("doks")

    def test_the_api_runs_as_its_own_service_account(self):
        pod = one(self.docs, "Deployment", "api")["spec"]["template"]["spec"]
        self.assertEqual(pod.get("serviceAccountName"), "api")
        one(self.docs, "ServiceAccount", "api")

    def test_the_role_can_only_get_the_api_deployment(self):
        role = one(self.docs, "Role", "api-status")
        self.assertEqual(
            role["rules"],
            [{"apiGroups": ["apps"], "resources": ["deployments"], "resourceNames": ["api"], "verbs": ["get"]}],
        )

    def test_the_binding_gives_that_role_to_that_account_only(self):
        binding = one(self.docs, "RoleBinding", "api-status")
        self.assertEqual(binding["roleRef"], {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "api-status"})
        self.assertEqual(binding["subjects"], [{"kind": "ServiceAccount", "name": "api", "namespace": "contentcollab"}])

    def test_no_cluster_wide_access(self):
        kinds = {d["kind"] for d in self.docs}
        self.assertNotIn("ClusterRole", kinds)
        self.assertNotIn("ClusterRoleBinding", kinds)

    def test_other_workloads_do_not_get_a_token(self):
        # Only the API needs the Kubernetes API; the others keep the default account without a token
        for name in ("worker",):
            pod = one(self.docs, "Deployment", name)["spec"]["template"]["spec"]
            self.assertNotEqual(pod.get("serviceAccountName"), "api", name)


if __name__ == "__main__":
    unittest.main()
