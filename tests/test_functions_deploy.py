"""The deploy workflow's Functions job (#180, ARCHITECTURE D39): it deploys functions/ on a merge to main,
skips with a clear message when its inputs are missing, and never lets the shared value near the repository
or a command line.

Run from the repository root:  python3 -m unittest tests.test_functions_deploy -v
Needs PyYAML and bash. CI runs it in the `k8s` job, with the other workflow and manifest tests.
"""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = yaml.safe_load((ROOT / ".github" / "workflows" / "deploy.yml").read_text(encoding="utf-8"))
PROJECT = yaml.safe_load((ROOT / "functions" / "project.yml").read_text(encoding="utf-8"))
GIT_BASH = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "bin" / "bash.exe"
BASH = os.environ.get("TEST_BASH") or (str(GIT_BASH) if os.name == "nt" and GIT_BASH.exists() else "bash")
CHECK = "Check for Functions inputs"
NEEDED = ("API_TOKEN", "AUTH_VALUE", "NAMESPACE")


def job():
    return DEPLOY["jobs"]["functions"]


def step(name):
    return next(s for s in job()["steps"] if s.get("name") == name)


def run_check(env):
    """Runs the check step's shell with only the given environment; returns (output file text, stdout)."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "output"
        summary = Path(tmp) / "summary"
        out.write_text("")
        summary.write_text("")
        full = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(out), "GITHUB_STEP_SUMMARY": str(summary)}
        full.update(env)
        done = subprocess.run(
            [BASH, "-c", step(CHECK)["run"]], env=full, capture_output=True, text=True, check=True
        )
        return out.read_text(), done.stdout + summary.read_text()


class FunctionsJob(unittest.TestCase):
    def test_a_job_that_needs_the_checks_and_no_cluster(self):
        self.assertEqual(job()["needs"], "checks")

    def test_runs_when_functions_change(self):
        paths = DEPLOY["on"]["push"]["paths"] if "on" in DEPLOY else DEPLOY[True]["push"]["paths"]
        self.assertIn("functions/**", paths)

    def test_every_step_after_the_check_waits_for_it(self):
        later = [s for s in job()["steps"] if s.get("name") != CHECK and not str(s.get("uses", "")).startswith("actions/checkout")]
        self.assertTrue(later)
        for s in later:
            self.assertIn("steps.functions.outputs.present == 'true'", s.get("if", ""), s)

    def test_skips_with_a_message_when_an_input_is_missing(self):
        full = {k: "x" for k in NEEDED}
        for missing in NEEDED:
            env = {k: v for k, v in full.items() if k != missing}
            output, shown = run_check(env)
            self.assertIn("present=false", output, missing)
            self.assertIn("skipped", shown.lower(), missing)

    def test_goes_ahead_when_all_inputs_are_there(self):
        output, _ = run_check({k: "x" for k in NEEDED})
        self.assertIn("present=true", output)

    def test_the_shared_value_is_only_ever_an_environment_variable(self):
        for s in job()["steps"]:
            self.assertNotIn("${{ secrets.", s.get("run", ""), s)

    def test_the_env_file_is_written_outside_the_checkout(self):
        deploy = next(s for s in job()["steps"] if "serverless deploy" in s.get("run", ""))
        self.assertIn("$RUNNER_TEMP", deploy["run"])
        self.assertIn("--env", deploy["run"])
        self.assertNotIn("echo \"$AUTH_VALUE\"", deploy["run"], "never echo the value")

    def test_project_reads_the_shared_value_from_the_environment(self):
        fn = PROJECT["packages"][0]["functions"][0]
        self.assertEqual(fn["webSecure"], "${FUNCTION_AUTH_TOKEN}")
        self.assertIs(fn["web"], True)


if __name__ == "__main__":
    unittest.main()
