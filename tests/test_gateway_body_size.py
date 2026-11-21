"""The Gateway accepts uploads up to the API's own limit (D29, #116): NGF applies nginx's
client_max_body_size, 1 MiB by default, so without a ClientSettingsPolicy a normal PDF gets a 413
before it reaches the API (INF-2, TST-5).

Run from the repository root:  python3 -m unittest tests.test_gateway_body_size -v
Needs kubectl (for `kubectl kustomize`) and PyYAML. CI runs it in the `k8s` job.
"""

import re
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
UPLOAD_LIMIT_MIB = 50  # parseUpload.ts MAX_FILE_SIZE in the API


def render(overlay):
    out = subprocess.run(
        ["kubectl", "kustomize", f"k8s/{overlay}"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def to_mib(size):
    """An nginx size (k, m, g or plain bytes) in MiB."""
    m = re.fullmatch(r"(\d+)([kmg]?)", size, re.IGNORECASE)
    assert m, f"not an nginx size: {size!r}"
    factor = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[m.group(2).lower()]
    return int(m.group(1)) * factor / 1024**2


class GatewayBodySize(unittest.TestCase):
    def setUp(self):
        self.docs = render("doks")
        self.gateway = next(d for d in self.docs if d["kind"] == "Gateway")
        self.policies = [d for d in self.docs if d["kind"] == "ClientSettingsPolicy"]

    def test_one_policy_targets_the_gateway(self):
        [policy] = self.policies
        self.assertEqual(policy["apiVersion"], "gateway.nginx.org/v1alpha1")
        self.assertEqual(policy["spec"]["targetRef"], {
            "group": "gateway.networking.k8s.io",
            "kind": "Gateway",
            "name": self.gateway["metadata"]["name"],
        })

    def test_policy_is_in_the_gateways_namespace(self):
        # A policy must be in the namespace of the resource it targets
        [policy] = self.policies
        self.assertEqual(policy["metadata"]["namespace"], self.gateway["metadata"]["namespace"])

    def test_body_limit_covers_the_apis_upload_limit(self):
        [policy] = self.policies
        self.assertGreaterEqual(to_mib(policy["spec"]["body"]["maxSize"]), UPLOAD_LIMIT_MIB)

    def test_limit_is_not_switched_off(self):
        # "0" disables the check (NGF API reference); the API's limit would be the only one
        [policy] = self.policies
        self.assertNotEqual(to_mib(policy["spec"]["body"]["maxSize"]), 0)

    def test_minikube_has_no_nginx_policy_crd_to_apply(self):
        # The minikube overlay has no NGF; a policy there would not apply
        self.assertEqual([d for d in render("minikube") if d["kind"] == "ClientSettingsPolicy"], [])


if __name__ == "__main__":
    unittest.main()
