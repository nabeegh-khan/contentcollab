// Tests for the version calls on main (docs/API.md, Versions): list, upload a new version, download.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client.js";
import { downloadVersion, listVersions, uploadVersion } from "./versions.js";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("listVersions", () => {
  it("returns the versions of a document, oldest first, with the token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json(200, { items: [{ number: 1 }, { number: 2 }] }));
    vi.stubGlobal("fetch", fetchMock);

    const versions = await listVersions("t0k", "d-1");

    expect(versions.map((v) => v.number)).toEqual([1, 2]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/documents/d-1/versions");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
  });

  it("accepts a bare array too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, [{ number: 1 }])));
    expect(await listVersions("t0k", "d-1")).toHaveLength(1);
  });

  it("throws the API error with its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(403, { error: "Forbidden", code: "FORBIDDEN" })),
    );
    await expect(listVersions("t0k", "d-1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("uploadVersion", () => {
  it("posts the file as multipart form data under the name file, without a JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(201, { id: "v-2", number: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" });

    const created = await uploadVersion("t0k", "d-1", file);

    expect(created).toEqual({ id: "v-2", number: 2 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/documents/d-1/versions");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("file").name).toBe("report.pdf");
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(init.headers.Authorization).toBe("Bearer t0k");
  });

  it("throws the API error for a file already uploaded (409) or too large (413)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(409, { error: "Conflict", code: "CONFLICT" })),
    );
    await expect(uploadVersion("t0k", "d-1", new File(["x"], "a.pdf"))).rejects.toMatchObject({
      status: 409,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(413, { error: "Too large", code: "TOO_LARGE" })),
    );
    await expect(uploadVersion("t0k", "d-1", new File(["x"], "a.pdf"))).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe("downloadVersion", () => {
  it("fetches the file's bytes with the token and returns a blob", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("PDFBYTES", { status: 200, headers: { "Content-Type": "application/pdf" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const blob = await downloadVersion("t0k", "d-1", "v-2");

    expect(await blob.text()).toBe("PDFBYTES");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/documents/d-1/versions/v-2/content");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
  });

  it("throws an ApiError when the file is missing (404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(404, { error: "Not found", code: "NOT_FOUND" })),
    );
    await expect(downloadVersion("t0k", "d-1", "v-1")).rejects.toBeInstanceOf(ApiError);
  });
});
