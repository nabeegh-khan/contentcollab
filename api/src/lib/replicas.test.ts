import { describe, expect, it } from "@jest/globals";
import { readyReplicas, DEPLOYMENT_PATH, type KubeGet } from "./replicas.js";

// Ready API replicas for the status page (#30, D23): read from the Kubernetes API with the pod's own
// service account. The HTTP call is injected, so no cluster is needed here.
const READY = 3;
const FORBIDDEN = 403;

describe("readyReplicas", () => {
  it("asks for the api Deployment in the app namespace and returns its ready replicas", async () => {
    const asked: string[] = [];
    const get: KubeGet = async (path) => {
      asked.push(path);
      return { status: { readyReplicas: READY } };
    };
    expect(await readyReplicas(get)).toEqual({ api: READY });
    expect(asked).toEqual([DEPLOYMENT_PATH]);
    expect(DEPLOYMENT_PATH).toBe("/apis/apps/v1/namespaces/contentcollab/deployments/api");
  });

  it("no ready replicas is 0, not missing", async () => {
    expect(await readyReplicas(async () => ({ status: {} }))).toEqual({ api: 0 });
  });

  it("a reply without a status is an error, not a number", async () => {
    await expect(readyReplicas(async () => ({ kind: "Status", code: FORBIDDEN }))).rejects.toThrow(
      "deployment",
    );
  });
});
