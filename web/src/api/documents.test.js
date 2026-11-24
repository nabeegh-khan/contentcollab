// Tests for the document calls on main (docs/API.md, Documents): list a page and create a document with its first version.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client.js";
import { createDocument, getDocument, listDocuments } from "./documents.js";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("listDocuments", () => {
  it("asks for the first page with the token and returns items and the next cursor", async () => {
    const page = { items: [{ id: "d-1" }], nextCursor: "abc" };
    const fetchMock = vi.fn().mockResolvedValue(json(200, page));
    vi.stubGlobal("fetch", fetchMock);

    const answer = await listDocuments("t0k");

    expect(answer).toEqual(page);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/documents?limit=20");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
  });

  it("sends the cursor of the previous page, encoded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await listDocuments("t0k", { cursor: "a+b/c=" });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/documents?limit=20&cursor=a%2Bb%2Fc%3D");
  });

  it("throws the API's error with its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => json(401, { error: "no", code: "UNAUTHORIZED" })),
    );
    await expect(listDocuments("bad")).rejects.toMatchObject({ status: 401 });
    await expect(listDocuments("bad")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("createDocument", () => {
  it("posts the file and the title as multipart form data, without a Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(201, { id: "d-2", title: "Plan" }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "plan.pdf", { type: "application/pdf" });

    const created = await createDocument("t0k", file, "Plan");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/documents");
    expect(init.method).toBe("POST");
    expect(init.body.get("file").name).toBe("plan.pdf");
    expect(init.body.get("title")).toBe("Plan");
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(created.id).toBe("d-2");
  });

  it("leaves the title out when it is blank, so the API uses the file name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(201, { id: "d-3" }));
    vi.stubGlobal("fetch", fetchMock);

    await createDocument("t0k", new File(["x"], "a.pdf"), "   ");

    expect(fetchMock.mock.calls[0][1].body.has("title")).toBe(false);
  });
});

describe("getDocument", () => {
  it("asks GET /documents/:id with the token and returns the document", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "d1", title: "Design review draft" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const doc = await getDocument("t0k", "d1");

    expect(doc.title).toBe("Design review draft");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/documents/d1");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
  });
});
