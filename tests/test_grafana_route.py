"""The operations panel links to Grafana through the Gateway (#161, ARCHITECTURE D19 and D31).

The demo runs without a terminal, so Grafana must be reachable at https://contentcollab.app/grafana/
and the panel must carry the link. The API shows the link only when GRAFANA_URL is set
(api/src/server.ts, web/src/ops/OpsPage.jsx). Grafana keeps its login (anonymous access stays off).

Run from the repository root:  python3 -m unittest tests.test_grafana_route -v
Needs kubectl (for `kubectl kustomize`) and PyYAML; CI runs it in the `k8s` job.
"""

import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_URL = "https://contentcollab.app/grafana/"


def render(path):
    out = subprocess.run(
        ["kubectl", "kustomize", path], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def one(docs, kind, name):
    found = [d for d in docs if d["kind"] == kind and d["metadata"]["name"] == name]
    assert len(found) == 1, f"{kind}/{name}: {len(found)} found"
    return found[0]


def env_of(deployment):
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    return {e["name"]: e.get("value") for e in container.get("env", [])}


class GrafanaLinkOnTheCluster(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doks = render("k8s/doks")
        cls.minikube = render("k8s/minikube")
        cls.observability = render("k8s/observability")

    def test_the_api_is_told_where_grafana_is_on_the_cluster_only(self):
        self.assertEqual(one(self.doks, "ConfigMap", "app-config")["data"].get("GRAFANA_URL"), PUBLIC_URL)
        # minikube has no public host, so a link to contentcollab.app would point at the wrong place
        self.assertNotIn("GRAFANA_URL", one(self.minikube, "ConfigMap", "app-config")["data"])

    def test_one_route_sends_the_grafana_path_to_the_grafana_service_without_the_prefix(self):
        route = one(self.doks, "HTTPRoute", "grafana")
        self.assertEqual(route["metadata"]["namespace"], "contentcollab")  # the Gateway takes routes of its own namespace
        self.assertEqual(route["spec"]["hostnames"], ["contentcollab.app"])
        # HTTPS only: the login form is never served over plain HTTP
        self.assertEqual(route["spec"]["parentRefs"], [{"name": "contentcollab", "sectionName": "https"}])
        [rule] = route["spec"]["rules"]
        self.assertEqual(rule["matches"], [{"path": {"type": "PathPrefix", "value": "/grafana"}}])
        self.assertEqual(
            rule["filters"],
            [{"type": "URLRewrite", "urlRewrite": {"path": {"type": "ReplacePrefixMatch", "replacePrefixMatch": "/"}}}],
        )
        [backend] = rule["backendRefs"]
        self.assertEqual((backend["name"], backend["namespace"], backend["port"]), ("grafana", "observability", 3000))

    def test_the_observability_namespace_allows_that_route_and_nothing_wider(self):
        grant = one(self.observability, "ReferenceGrant", "grafana-from-gateway-route")
        self.assertEqual(grant["metadata"]["namespace"], "observability")
        self.assertEqual(
            grant["spec"]["from"],
            [{"group": "gateway.networking.k8s.io", "kind": "HTTPRoute", "namespace": "contentcollab"}],
        )
        self.assertEqual(grant["spec"]["to"], [{"group": "", "kind": "Service", "name": "grafana"}])

    def test_grafana_builds_its_links_for_the_public_path_and_keeps_its_login(self):
        env = env_of(one(self.observability, "Deployment", "grafana"))
        self.assertEqual(env.get("GF_SERVER_ROOT_URL"), PUBLIC_URL)
        # The Gateway strips the prefix, so Grafana must not also serve from the sub path
        self.assertNotEqual(env.get("GF_SERVER_SERVE_FROM_SUB_PATH"), "true")
        self.assertEqual(env.get("GF_AUTH_ANONYMOUS_ENABLED"), "false")


if __name__ == "__main__":
    unittest.main()
