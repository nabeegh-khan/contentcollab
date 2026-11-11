// Runs a shell script from scripts/ against stand-ins for kubectl, doctl, aws and curl, so a test
// never reaches a cluster or a cloud account. Two guards: the run is refused unless every stubbed
// command resolves inside the sandbox (a real doctl once ran from a test whose PATH was wrong), and
// KUBECONFIG points at a file that does not exist.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dirname, "..");
// Anything that could aim a script at a real account or change its behaviour
const SCRUBBED = /^(KUBECONFIG|KUBE_CONTEXT|NAMESPACE|SECRET_NAME|RESTART|DIGITALOCEAN_.*|DOCTL_.*|AWS_.*|SPACES_.*|DB_.*|JWT_SECRET|PROJECT_NAME|ENVIRONMENT|FOREIGN_BUCKET|STUB_.*)$/;

/** @param stubs {command: file in scripts/testdata}; each becomes an executable on PATH */
export function sandbox(stubs) {
  const dir = mkdtempSync(join(tmpdir(), "stubs-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, file] of Object.entries(stubs)) {
    const body = readFileSync(join(repoRoot, "scripts", "testdata", file), "utf8").replaceAll("\r\n", "\n");
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}`);
    chmodSync(join(bin, name), 0o755);
  }
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUBBED.test(k)));
  const envFor = (extra = {}) => ({
    ...baseEnv,
    [pathKey]: `${bin}${delimiter}${process.env[pathKey]}`,
    KUBECONFIG: join(dir, "no-such-kubeconfig"),
    STUB_DIR: dir,
    ...extra,
  });

  const guard = (env) => {
    for (const name of Object.keys(stubs)) {
      const found = spawnSync("bash", ["-c", `command -v ${name}`], { env, encoding: "utf8" }).stdout.trim();
      if (!found.includes(basename(dir))) throw new Error(`${name} resolves to '${found}', not the stub: refusing to run`);
    }
  };

  return {
    dir,
    /** Runs scripts/<script> with bash; returns status, stdout, stderr and the files the stubs wrote. */
    run(script, { env = {}, input = "", args = [] } = {}) {
      const full = envFor(env);
      guard(full);
      const result = spawnSync("bash", [`scripts/${script}`, ...args], {
        cwd: repoRoot,
        env: full,
        input,
        encoding: "utf8",
        timeout: 60_000,
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: `${result.stdout}${result.stderr}` };
    },
    /** Contents of a file a stub wrote into the sandbox, or "" if it wrote none. */
    file: (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : ""),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
