import { describe, expect, it } from "@jest/globals";
import { EventEmitter } from "node:events";
import {
  readyReplicas,
  inClusterGet,
  cachedFor,
  DEPLOYMENT_PATH,
  type KubeGet,
  type HttpsDeps,
} from "./replicas.js";

// Ready API replicas for the status page (#30, D23): read from the Kubernetes API with the pod's own
// service account. The HTTP call is injected, so no cluster is needed here.
const READY = 3;
const OK = 200;
const FORBIDDEN = 403;
const HOST = "10.245.0.1";
const PORT = "443";
// The body the apiserver sends for a denied request
const FORBIDDEN_STATUS = {
  kind: "Status",
  apiVersion: "v1",
  status: "Failure",
  reason: "Forbidden",
  code: FORBIDDEN,
};

describe("readyReplicas", () => {
  it("asks for the api Deployment in the app namespace and returns its ready replicas", async () => {
    const asked: string[] = [];
    const get: KubeGet = async (path) => {
      asked.push(path);
      return { kind: "Deployment", status: { readyReplicas: READY } };
    };
    expect(await readyReplicas(get)).toEqual({ api: READY });
    expect(asked).toEqual([DEPLOYMENT_PATH]);
    expect(DEPLOYMENT_PATH).toBe("/apis/apps/v1/namespaces/contentcollab/deployments/api");
  });

  it("no ready replicas is 0, not missing", async () => {
    expect(await readyReplicas(async () => ({ kind: "Deployment", status: {} }))).toEqual({
      api: 0,
    });
  });

  it("a Status reply (denied, not found) is an error, not 0", async () => {
    await expect(readyReplicas(async () => FORBIDDEN_STATUS)).rejects.toThrow("deployment");
  });
});

// A stand-in for node:https request: answers with the given status and body, or fails mid-body
function fakeHttps(statusCode: number, body: string, failMidBody = false) {
  const calls: Array<{ host?: string; headers?: Record<string, string>; ca?: unknown }> = [];
  const request: HttpsDeps["request"] = (options, onResponse) => {
    calls.push(options as never);
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(err?: Error): void };
    req.destroy = (err) => {
      if (err) req.emit("error", err);
    };
    req.end = () => {
      const res = Object.assign(new EventEmitter(), { statusCode });
      setImmediate(() => {
        onResponse(res as never);
        res.emit("data", Buffer.from(body));
        if (failMidBody) res.emit("error", new Error("aborted"));
        else res.emit("end");
      });
    };
    return req as never;
  };
  return { request, calls };
}

const files: HttpsDeps["readFile"] = (path) =>
  path.endsWith("token") ? "the-token\n" : Buffer.from("the-ca");

describe("inClusterGet", () => {
  const env = { KUBERNETES_SERVICE_HOST: HOST, KUBERNETES_SERVICE_PORT: PORT };

  it("is null outside a cluster", () => {
    expect(inClusterGet({})).toBeNull();
  });

  it("sends the mounted token and CA, and parses a 2xx body", async () => {
    const https = fakeHttps(OK, JSON.stringify({ kind: "Deployment" }));
    const get = inClusterGet(env, { request: https.request, readFile: files })!;
    expect(await get(DEPLOYMENT_PATH)).toEqual({ kind: "Deployment" });
    expect(https.calls[0]?.host).toBe(HOST);
    expect(https.calls[0]?.headers?.Authorization).toBe("Bearer the-token");
    expect(https.calls[0]?.ca).toEqual(Buffer.from("the-ca"));
  });

  it("rejects a non-2xx reply before reading it as a Deployment", async () => {
    const https = fakeHttps(FORBIDDEN, JSON.stringify(FORBIDDEN_STATUS));
    const get = inClusterGet(env, { request: https.request, readFile: files })!;
    await expect(get(DEPLOYMENT_PATH)).rejects.toThrow(String(FORBIDDEN));
  });

  it("rejects when the reply breaks off", async () => {
    const https = fakeHttps(OK, "{", true);
    const get = inClusterGet(env, { request: https.request, readFile: files })!;
    await expect(get(DEPLOYMENT_PATH)).rejects.toThrow("aborted");
  });

  it("rejects when the token is not mounted", async () => {
    const https = fakeHttps(OK, "{}");
    const missing: HttpsDeps["readFile"] = () => {
      throw new Error("ENOENT");
    };
    const get = inClusterGet(env, { request: https.request, readFile: missing })!;
    await expect(get(DEPLOYMENT_PATH)).rejects.toThrow("ENOENT");
  });
});

describe("cachedFor", () => {
  it("answers from the last read until it is older than the limit", async () => {
    const TTL_MS = 5000;
    let now = 0;
    let reads = 0;
    const read = cachedFor(
      TTL_MS,
      async () => ++reads,
      () => now,
    );
    expect(await read()).toBe(1);
    now = TTL_MS - 1;
    expect(await read()).toBe(1);
    now = TTL_MS;
    expect(await read()).toBe(2);
  });

  it("does not keep a failed read", async () => {
    let calls = 0;
    const read = cachedFor(
      1,
      async () => {
        calls += 1;
        throw new Error("down");
      },
      () => 0,
    );
    await expect(read()).rejects.toThrow("down");
    await expect(read()).rejects.toThrow("down");
    const TWO_READS = 2;
    expect(calls).toBe(TWO_READS);
  });
});
