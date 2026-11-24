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

    def test_the_only_cluster_wide_objects_are_the_node_reader_and_the_volume_reader(self):
        # D31: nodes are cluster-scoped, so the operations panel needs a ClusterRole; D35: so are
        # PersistentVolumes, which get a second, separate one, and nothing more
        cluster = {
            (d["kind"], d["metadata"]["name"])
            for d in self.docs
            if d["kind"] in ("ClusterRole", "ClusterRoleBinding")
        }
        self.assertEqual(
            cluster,
            {
                ("ClusterRole", "contentcollab-api-nodes"),
                ("ClusterRoleBinding", "contentcollab-api-nodes"),
                ("ClusterRole", "contentcollab-api-volumes"),
                ("ClusterRoleBinding", "contentcollab-api-volumes"),
            },
        )

    def test_the_volume_reader_can_only_get_persistent_volumes(self):
        # D35: the reclaim policy of the volume behind the database claim. `get` only: the API reads
        # the one volume its claim names, it cannot list the cluster's volumes
        role = one(self.docs, "ClusterRole", "contentcollab-api-volumes")
        self.assertEqual(role["rules"], [{"apiGroups": [""], "resources": ["persistentvolumes"], "verbs": ["get"]}])
        binding = one(self.docs, "ClusterRoleBinding", "contentcollab-api-volumes")
        self.assertEqual(
            binding["roleRef"],
            {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "contentcollab-api-volumes"},
        )
        self.assertEqual(
            binding["subjects"], [{"kind": "ServiceAccount", "name": "api", "namespace": "contentcollab"}]
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

    def test_the_ops_role_reads_pods_logs_events_one_hpa_one_claim_workloads_and_the_backup(self):
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
                # D35: desired copies per part; a list cannot be narrowed to a name without a field selector
                {"apiGroups": ["apps"], "resources": ["deployments", "statefulsets"], "verbs": ["list"]},
                # D35: the nightly backup, by name; its Jobs carry a timestamp in their names, so they are listed
                {"apiGroups": ["batch"], "resources": ["cronjobs"], "resourceNames": ["db-backup"], "verbs": ["get"]},
                {"apiGroups": ["batch"], "resources": ["jobs"], "verbs": ["list"]},
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
        names = ("api-ops", "contentcollab-api-nodes", "contentcollab-api-volumes")
        roles = [d for d in self.docs if d["kind"] in ("Role", "ClusterRole") and d["metadata"]["name"] in names]
        self.assertEqual(len(roles), 3)
        for role in roles:
            for rule in role["rules"]:
                self.assertTrue(set(rule["verbs"]) <= {"get", "list"}, role["metadata"]["name"])
                self.assertNotIn("pods/exec", rule["resources"])
                self.assertFalse([r for r in rule["resources"] if r.startswith("sec")], role["metadata"]["name"])

    def test_the_api_finds_prometheus_through_its_settings(self):
        config = one(self.docs, "ConfigMap", "app-config")
        self.assertEqual(config["data"]["PROMETHEUS_URL"], "http://prometheus.observability.svc:9090")

    def test_the_drill_role_can_only_create_evictions(self):
        # D31: stopping one pod, which its controller replaces, is the only write the API may do
        role = one(self.docs, "Role", "api-drill")
        self.assertEqual(role["rules"], [{"apiGroups": [""], "resources": ["pods/eviction"], "verbs": ["create"]}])
        binding = one(self.docs, "RoleBinding", "api-drill")
        self.assertEqual(
            binding["roleRef"], {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "api-drill"}
        )
        self.assertEqual(
            binding["subjects"], [{"kind": "ServiceAccount", "name": "api", "namespace": "contentcollab"}]
        )

    def test_the_drill_permission_is_its_own_file_so_removing_it_switches_drills_off(self):
        text = (ROOT / "k8s" / "base" / "kustomization.yaml").read_text(encoding="utf-8")
        self.assertIn("  - api-drill-rbac.yaml", text)
        drill_file = (ROOT / "k8s" / "base" / "api-drill-rbac.yaml").read_text(encoding="utf-8")
        docs = [d for d in yaml.safe_load_all(drill_file) if d]
        self.assertEqual({(d["kind"], d["metadata"]["name"]) for d in docs}, {("Role", "api-drill"), ("RoleBinding", "api-drill")})
        # and it is nowhere else: api-rbac.yaml must not grant eviction
        main_file = (ROOT / "k8s" / "base" / "api-rbac.yaml").read_text(encoding="utf-8")
        self.assertNotIn("pods/eviction", main_file)

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
