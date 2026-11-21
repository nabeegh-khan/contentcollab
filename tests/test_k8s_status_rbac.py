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

    def test_the_only_cluster_wide_objects_are_the_namespace_and_the_node_reader(self):
        # D31: nodes are cluster-scoped, so the operations panel needs one ClusterRole, and nothing more
        cluster = {
            (d["kind"], d["metadata"]["name"])
            for d in self.docs
            if d["kind"] in ("ClusterRole", "ClusterRoleBinding")
        }
        self.assertEqual(
            cluster,
            {("ClusterRole", "contentcollab-api-nodes"), ("ClusterRoleBinding", "contentcollab-api-nodes")},
        )

    def test_the_node_reader_can_only_get_and_list_nodes_and_their_metrics(self):
        role = one(self.docs, "ClusterRole", "contentcollab-api-nodes")
        self.assertEqual(
            role["rules"],
            [
                {"apiGroups": [""], "resources": ["nodes"], "verbs": ["get", "list"]},
                {"apiGroups": ["metrics.k8s.io"], "resources": ["nodes"], "verbs": ["get", "list"]},
            ],
        )
        binding = one(self.docs, "ClusterRoleBinding", "contentcollab-api-nodes")
        self.assertEqual(
            binding["roleRef"],
            {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "contentcollab-api-nodes"},
        )
        self.assertEqual(
            binding["subjects"], [{"kind": "ServiceAccount", "name": "api", "namespace": "contentcollab"}]
        )

    def test_the_ops_role_reads_pods_logs_events_one_hpa_and_one_claim(self):
        role = one(self.docs, "Role", "api-ops")
        self.assertEqual(
            role["rules"],
            [
                {"apiGroups": [""], "resources": ["pods"], "verbs": ["get", "list"]},
                {"apiGroups": [""], "resources": ["pods/log"], "verbs": ["get"]},
                {"apiGroups": ["events.k8s.io"], "resources": ["events"], "verbs": ["list"]},
                {
                    "apiGroups": ["autoscaling"],
                    "resources": ["horizontalpodautoscalers"],
                    "resourceNames": ["api"],
                    "verbs": ["get"],
                },
                {
                    "apiGroups": [""],
                    "resources": ["persistentvolumeclaims"],
                    "resourceNames": ["data-postgres-0"],
                    "verbs": ["get"],
                },
            ],
        )
        binding = one(self.docs, "RoleBinding", "api-ops")
        self.assertEqual(
            binding["roleRef"], {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "api-ops"}
        )
        self.assertEqual(
            binding["subjects"], [{"kind": "ServiceAccount", "name": "api", "namespace": "contentcollab"}]
        )

    def test_the_panels_roles_only_read(self):
        # D31 PR 1 is read-only: no verb but get and list, and nothing on credentials or exec
        names = ("api-ops", "contentcollab-api-nodes")
        roles = [d for d in self.docs if d["kind"] in ("Role", "ClusterRole") and d["metadata"]["name"] in names]
        self.assertEqual(len(roles), 2)
        for role in roles:
            for rule in role["rules"]:
                self.assertTrue(set(rule["verbs"]) <= {"get", "list"}, role["metadata"]["name"])
                self.assertNotIn("pods/exec", rule["resources"])
                self.assertFalse([r for r in rule["resources"] if r.startswith("sec")], role["metadata"]["name"])

    def test_the_api_finds_prometheus_through_its_settings(self):
        config = one(self.docs, "ConfigMap", "app-config")
        self.assertEqual(config["data"]["PROMETHEUS_URL"], "http://prometheus.observability.svc:9090")

    def test_other_workloads_do_not_run_as_the_api_account(self):
        # Only the API may read its Deployment; every other workload (worker, redis, the postgres
        # StatefulSet, any Job) keeps the namespace's default account
        workloads = [d for d in self.docs if d["kind"] in ("Deployment", "StatefulSet", "Job", "DaemonSet")]
        others = [d for d in workloads if d["metadata"]["name"] != "api"]
        self.assertIn("postgres", {d["metadata"]["name"] for d in others})
        for d in others:
            pod = d["spec"]["template"]["spec"]
            self.assertNotEqual(pod.get("serviceAccountName"), "api", f'{d["kind"]}/{d["metadata"]["name"]}')


if __name__ == "__main__":
    unittest.main()
