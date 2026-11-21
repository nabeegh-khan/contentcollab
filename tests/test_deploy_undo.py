"""Runs deploy.yml's rollout and smoke steps against stand-ins: undo only what this run changed, and all of it (#108, D25).

Run from the repository root:  python3 -m unittest tests.test_deploy_undo -v
Needs bash and PyYAML; no cluster. The step bodies are taken from deploy.yml as written, with
${{ github.sha }} replaced, and run under `bash -e`, as GitHub runs a step that sets no `shell:`. kubectl, kustomize,
doctl, curl and sleep are stand-ins first on PATH; tests/testdata/deploy-kubectl-stub.sh keeps each
Deployment's image and revision. DEPLOY_WORKFLOW points the checks at another copy of deploy.yml.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = Path(os.environ.get("DEPLOY_WORKFLOW", ROOT / ".github" / "workflows" / "deploy.yml")).read_text()
STUB = (ROOT / "tests" / "testdata" / "deploy-kubectl-stub.sh").read_text().replace("\r\n", "\n")
SHA = "0123abc"
# On Windows, "bash" can resolve to WSL's, whose PATH and kubectl are not ours; Git Bash is used there instead
GIT_BASH = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "bin" / "bash.exe"
BASH = os.environ.get("TEST_BASH") or (str(GIT_BASH) if os.name == "nt" and GIT_BASH.exists() else "bash")
# Put the stand-ins first inside bash itself: Git Bash puts its own /mingw64/bin and /usr/bin (with a real
# curl and sleep) ahead of the PATH it inherits, and needs the folder as a POSIX path
STUBS_FIRST = (
    'if command -v cygpath >/dev/null; then PATH="$(cygpath -u "$STUB_BIN"):$PATH"; '
    'else PATH="$STUB_BIN:$PATH"; fi; export PATH\n'
)
ROLLOUT_STEP = "Roll the Deployments to this commit"
SMOKE_STEP = "Smoke check, roll back on failure"
# Every Deployment the deploy pins, watches and undoes together (D25, D27)
DEPLOYMENTS = ("api", "worker", "web")
ALL = "\n".join(DEPLOYMENTS)
# Revisions the rollout step hands the smoke step, one per Deployment
BEFORE = {f"REV_BEFORE_{svc}": "7" for svc in DEPLOYMENTS}


def workflow():
    return yaml.safe_load(DEPLOY)


def step_body(name):
    step = next(s for s in workflow()["jobs"]["rollout"]["steps"] if s.get("name") == name)
    return step["run"].replace("${{ github.sha }}", SHA)


class Cluster:
    """A temporary folder with the stand-ins and the state of the Deployments on an older commit."""

    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="deployundo-"))
        bin_dir = self.dir / "bin"
        bin_dir.mkdir()
        tools = {
            "kubectl": STUB,
            "kustomize": "exit 0\n",
            "doctl": 'echo "doctl $*" >> "$STUB_DIR/calls.log"\n',
            "sleep": "exit 0\n",
            "curl": 'cat "$STUB_DIR/health"\n',
        }
        for tool, body in tools.items():
            path = bin_dir / tool
            path.write_text("#!/usr/bin/env bash\n" + body, newline="\n")
            path.chmod(0o755)
        for svc in DEPLOYMENTS:
            self.write(f"image-{svc}", f"registry/contentcollab-{svc}:previous")
            self.write(f"rev-{svc}", "7")
        self.write("health", '{"status":"ok"}')
        self.write("github-env", "")
        self.write("summary", "")

    def write(self, name, text):
        (self.dir / name).write_text(text + ("\n" if text else ""), newline="\n")

    def read(self, name):
        path = self.dir / name
        return path.read_text() if path.exists() else ""

    def calls(self, verb):
        return [line for line in self.read("calls.log").splitlines() if verb in line]

    def env_file(self):
        return dict(line.split("=", 1) for line in self.read("github-env").splitlines() if "=" in line)

    def run(self, name, extra_env=None):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("STUB_", "KUBE"))}
        env.update(
            PATH=str(self.dir / "bin") + os.pathsep + env.get("PATH", ""),
            STUB_DIR=str(self.dir),
            STUB_SHA=SHA,
            REGISTRY="registry",
            GITHUB_ENV=str(self.dir / "github-env"),
            GITHUB_STEP_SUMMARY=str(self.dir / "summary"),
            SMOKE_URL="https://example.test",
            KUBECONFIG=str(self.dir / "no-kubeconfig"),
        )
        env.update(extra_env or {}, STUB_BIN=str(self.dir / "bin"))
        for tool in ("kubectl", "kustomize", "doctl", "curl", "sleep"):
            found = subprocess.run([BASH, "-c", STUBS_FIRST + f"command -v {tool}"], env=env, capture_output=True, text=True).stdout
            if self.dir.name not in found:
                raise RuntimeError(f"{tool} resolves to {found!r}, not the stand-in: refusing to run")
        return subprocess.run(
            [BASH, "-e", "-c", STUBS_FIRST + step_body(name)],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=60,
        )

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class RolloutStep(unittest.TestCase):
    def setUp(self):
        self.c = Cluster()
        self.addCleanup(self.c.close)

    def undone(self):
        return sorted(line.split("deployment/")[1].split()[0] for line in self.c.calls("rollout undo"))

    def test_a_clean_rollout_undoes_nothing(self):
        self.c.write("apply-changes", ALL)
        r = self.c.run(ROLLOUT_STEP)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.undone(), [])

    def test_revisions_before_the_apply_reach_the_smoke_step(self):
        self.c.write("apply-changes", ALL)
        self.c.run(ROLLOUT_STEP)
        self.assertEqual(self.c.env_file(), BEFORE)

    def test_a_failed_worker_also_undoes_the_others_this_run_changed(self):
        # #108 item 1: no mixed versions left behind
        self.c.write("apply-changes", ALL)
        self.c.write("status-fails", "worker")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), ["api", "web", "worker"])

    def test_a_failed_api_also_undoes_the_others_this_run_changed(self):
        self.c.write("apply-changes", ALL)
        self.c.write("status-fails", "api")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), ["api", "web", "worker"])

    def test_a_failed_web_also_undoes_the_api_and_worker_this_run_changed(self):
        # D27: the web Deployment is one of the set
        self.c.write("apply-changes", ALL)
        self.c.write("status-fails", "web")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), ["api", "web", "worker"])

    def test_a_failed_apply_is_reported_the_watch_runs_and_changes_are_undone(self):
        # #108 item 2: the apply moved all three, then failed partway
        self.c.write("apply-changes", ALL)
        self.c.write("apply-fails", "yes")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("apply", r.stdout.lower())
        self.assertEqual(len(self.c.calls("rollout status")), 3, "every Deployment is still watched")
        self.assertEqual(self.undone(), ["api", "web", "worker"])

    def test_a_failed_apply_that_changed_nothing_undoes_nothing(self):
        self.c.write("apply-fails", "yes")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), [])

    def test_a_rerun_of_the_same_commit_does_not_undo_past_what_is_running(self):
        # #108 item 3: the earlier run already deployed this commit; this apply creates no revision
        for svc in DEPLOYMENTS:
            self.c.write(f"image-{svc}", f"registry/contentcollab-{svc}:{SHA}")
        self.c.write("status-fails", "worker")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), [])
        self.assertIn("not changed by this run", r.stdout)

    def test_a_failed_undo_is_reported_and_the_others_are_still_undone(self):
        self.c.write("apply-changes", ALL)
        self.c.write("status-fails", "api")
        self.c.write("undo-fails", "api")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        # The failed api undo is still attempted; web and worker are undone
        self.assertEqual(self.undone(), ["api", "web", "worker"])
        self.assertIn("mixed versions", r.stdout)

    def test_an_unreadable_revision_is_reported_as_unreadable_not_as_unchanged(self):
        # The worker fails; the api's revision cannot be read after the apply (credentials ran out, say)
        self.c.write("apply-changes", ALL)
        self.c.write("status-fails", "worker")
        self.c.write("rev-read-fails", "api")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stdout, r"deployment/api[^\n]*revision[^\n]*unreadable")
        self.assertNotRegex(r.stdout, r"deployment/api[^\n]*not changed by this run")
        self.assertEqual(self.undone(), ["web", "worker"])

    def test_an_unreadable_revision_before_the_apply_is_not_taken_for_a_new_deployment(self):
        # A re-run of the same commit (no new revision); the read before the apply fails for the api
        for svc in DEPLOYMENTS:
            self.c.write(f"image-{svc}", f"registry/contentcollab-{svc}:{SHA}")
        self.c.write("status-fails", "worker")
        self.c.write("rev-read-fails-before", "api")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), [], "an undo here would go back past what is running")
        self.assertRegex(r.stdout, r"deployment/api[^\n]*revision[^\n]*unreadable")

    def test_a_first_deploy_counts_a_new_deployment_as_changed(self):
        # No Deployment exists before the apply; the worker then fails
        self.c.write("absent", ALL)
        self.c.write("apply-changes", ALL)
        self.c.write("status-fails", "worker")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), ["api", "web", "worker"])

    def test_a_healthy_deployment_left_alone_is_not_reported_as_an_error(self):
        # Re-run: the worker fails, the api is healthy and unchanged; only the worker gets an error line
        for svc in DEPLOYMENTS:
            self.c.write(f"image-{svc}", f"registry/contentcollab-{svc}:{SHA}")
        self.c.write("status-fails", "worker")
        r = self.c.run(ROLLOUT_STEP)
        self.assertNotRegex(r.stdout, r"::error::deployment/api")

    def test_credentials_are_refreshed_before_the_undo_after_the_watch(self):
        # The final undo can come after a 150 s migration and three 120 s waits (D27), near the 600 s login
        self.c.write("apply-changes", ALL)
        self.c.write("status-fails", "worker")
        self.c.run(ROLLOUT_STEP)
        calls = self.c.read("calls.log").splitlines()
        api_undo = next(i for i, line in enumerate(calls) if "rollout undo deployment/api" in line)
        self.assertTrue(
            any("kubeconfig save" in line for line in calls[:api_undo] if line.startswith("doctl")),
            "no fresh credentials before the final undo",
        )


class SmokeStep(unittest.TestCase):
    def setUp(self):
        self.c = Cluster()
        self.addCleanup(self.c.close)
        self.c.write("health", '{"status":"degraded","postgres":"down","redis":"ok"}')

    def undone(self):
        return sorted(line.split("deployment/")[1].split()[0] for line in self.c.calls("rollout undo"))

    def test_a_failed_smoke_check_undoes_every_deployment_this_run_changed(self):
        for svc in DEPLOYMENTS:
            self.c.write(f"rev-{svc}", "8")
        r = self.c.run(SMOKE_STEP, BEFORE)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), ["api", "web", "worker"])

    def test_a_failed_smoke_check_on_a_rerun_undoes_nothing_and_fails(self):
        # #108 item 3: revisions did not move in this run
        r = self.c.run(SMOKE_STEP, BEFORE)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), [])
        self.assertIn("not changed by this run", r.stdout)

    def test_only_the_deployment_this_run_changed_is_undone(self):
        self.c.write("rev-api", "8")
        r = self.c.run(SMOKE_STEP, BEFORE)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.undone(), ["api"])

    def test_a_healthy_service_passes(self):
        self.c.write("health", '{"status":"ok","postgres":"ok","redis":"ok"}')
        r = self.c.run(SMOKE_STEP, BEFORE)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.undone(), [])

    def test_an_unreadable_revision_is_reported_as_unreadable(self):
        self.c.write("applied", "")
        self.c.write("rev-read-fails", "api")
        self.c.write("rev-worker", "8")
        r = self.c.run(SMOKE_STEP, BEFORE)
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stdout, r"deployment/api[^\n]*revision[^\n]*unreadable")
        self.assertEqual(self.undone(), ["worker"])


class MarkdownOnlyPushes(unittest.TestCase):
    """#108 item 4: a markdown-only change under api/, worker/ or k8s/ starts no deploy."""

    def paths(self):
        on = workflow().get("on", workflow().get(True))  # PyYAML reads the key `on` as True
        return on["push"]["paths"]

    def test_markdown_is_excluded_after_every_include(self):
        paths = self.paths()
        self.assertEqual(paths[-1], "!**/*.md")
        self.assertTrue(all(not p.startswith("!") for p in paths[:-1]))

    def test_no_paths_ignore_beside_paths(self):
        on = workflow().get("on", workflow().get(True))
        self.assertNotIn("paths-ignore", on["push"])


if __name__ == "__main__":
    unittest.main()
