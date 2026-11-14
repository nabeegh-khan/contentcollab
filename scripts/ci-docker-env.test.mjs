// Every container CI starts from the API image must get a test JWT_SECRET (#127).
// Since #111 the server refuses to start without one, so a `docker run` of the
// image without it fails the smoke steps for a reason unrelated to the change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const IMAGE_TAG = "contentcollab-api:pr";
const ciPath = new URL("../.github/workflows/ci.yml", import.meta.url);

function apiDockerRunLines(workflowText) {
  return workflowText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("docker run") && line.includes(IMAGE_TAG));
}

test("ci.yml starts the API image at least once", () => {
  const lines = apiDockerRunLines(readFileSync(ciPath, "utf8"));
  assert.ok(lines.length > 0, `no docker run line for ${IMAGE_TAG} in ci.yml`);
});

test("every docker run of the API image passes JWT_SECRET", () => {
  const missing = apiDockerRunLines(readFileSync(ciPath, "utf8")).filter(
    (line) => !/\s-e JWT_SECRET=\S+/.test(line),
  );
  assert.deepEqual(missing, [], "docker run lines without -e JWT_SECRET=");
});
