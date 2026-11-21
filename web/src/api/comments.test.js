// Tests for the four comment calls on main (docs/API.md, Comments): paths, bodies, token, paging.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client.js";
import { createComment, deleteComment, listComments, updateComment } from "./comments.js";

function json(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "Content-Type": "application/json" },
  });
}

const DOC = "d-1";
const VER = "v-1";

describe("listComments", () => {
  it("follows nextCursor until it is null and returns every comment, oldest first", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { items: [{ id: "c1" }, { id: "c2" }], nextCursor: "abc" }))
      .mockResolvedValueOnce(json(200, { items: [{ id: "c3" }], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    const all = await listComments("t0k", DOC, VER);

    expect(all.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/v1/documents/${DOC}/versions/${VER}/comments?limit=100`,
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      `/api/v1/documents/${DOC}/versions/${VER}/comments?limit=100&cursor=abc`,
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
  });

  it("encodes the cursor it is given as is (it is opaque)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { items: [], nextCursor: "a+b/c=" }))
      .mockResolvedValueOnce(json(200, { items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await listComments("t0k", DOC, VER);

    expect(fetchMock.mock.calls[1][0]).toContain("cursor=a%2Bb%2Fc%3D");
  });

  it("stops after 50 pages instead of looping forever on a server that never ends", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => json(200, { items: [{ id: "c" }], nextCursor: "again" }));
    vi.stubGlobal("fetch", fetchMock);

    await listComments("t0k", DOC, VER);

    expect(fetchMock).toHaveBeenCalledTimes(50);
  });

  it("throws the API error with its real status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(403, { error: "Forbidden", code: "FORBIDDEN" })),
    );

    await expect(listComments("t0k", DOC, VER)).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      code: "FORBIDDEN",
    });
    await expect(listComments("t0k", DOC, VER)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("createComment", () => {
  it("posts body and parentId to the version's comments and returns the new comment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(201, { id: "c9", body: "hello" }));
    vi.stubGlobal("fetch", fetchMock);

    const created = await createComment("t0k", DOC, VER, { body: "hello", parentId: "c1" });

    expect(created).toEqual({ id: "c9", body: "hello" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/documents/${DOC}/versions/${VER}/comments`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ body: "hello", parentId: "c1" });
  });

  it("leaves parentId out of a top-level comment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(201, { id: "c9" }));
    vi.stubGlobal("fetch", fetchMock);

    await createComment("t0k", DOC, VER, { body: "hello" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ body: "hello" });
  });
});

describe("updateComment", () => {
  it("patches resolved on the comment's own path under the document", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { id: "c1", resolved: true }));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateComment("t0k", DOC, "c1", { resolved: true });

    expect(updated).toEqual({ id: "c1", resolved: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/documents/${DOC}/comments/c1`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ resolved: true });
  });
});

describe("deleteComment", () => {
  it("sends DELETE and resolves on 204 with nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(204, null));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteComment("t0k", DOC, "c1")).resolves.toBeNull();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/documents/${DOC}/comments/c1`);
    expect(init.method).toBe("DELETE");
  });
});
