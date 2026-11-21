// Render tests for the versions panel: list, open a version, upload a new one, download (D28, #116 on main).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VersionsPanel from "./VersionsPanel.jsx";

const DOC = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const V2 = "33333333-3333-4333-8333-333333333333";

function version(id, number, extra = {}) {
  return {
    id,
    documentId: DOC,
    number,
    filename: `file-${number}.pdf`,
    contentType: "application/pdf",
    size: 2048 * number,
    ...extra,
  };
}

// The server: GET and POST on /versions, GET on a version's content
function server(state, { postStatus = 201 } = {}) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method ?? "GET";
    const reply = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (method === "GET" && url.endsWith("/content")) {
      return new Response("BYTES", { status: 200, headers: { "Content-Type": "application/pdf" } });
    }
    if (method === "GET") return reply(200, { items: state.versions });
    if (method === "POST") {
      if (postStatus !== 201) return reply(postStatus, { error: "refused", code: "X" });
      const created = version(V2, state.versions.length + 1, {
        filename: init.body.get("file").name,
      });
      state.versions = [...state.versions, created];
      return reply(201, created);
    }
    return reply(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount(state, options) {
  const fetchMock = server(state, options);
  render(<VersionsPanel token="t0k" documentId={DOC} versionId={V1} />);
  return fetchMock;
}

const pdf = (name = "new.pdf") => new File(["%PDF-1.4"], name, { type: "application/pdf" });

describe("VersionsPanel", () => {
  it("lists the versions with number, file name and size, and marks the one being viewed", async () => {
    mount({ versions: [version(V1, 1), version(V2, 2)] });

    expect(await screen.findByText(/Version 1/)).toBeTruthy();
    expect(screen.getByText(/file-1\.pdf/)).toBeTruthy();
    expect(screen.getByText(/2 KB/)).toBeTruthy();
    expect(screen.getByText(/Version 2/)).toBeTruthy();
    expect(screen.getByText("Viewing")).toBeTruthy();
  });

  it("links every other version to its own address, so its comments open", async () => {
    mount({ versions: [version(V1, 1), version(V2, 2)] });
    await screen.findByText(/Version 2/);

    const link = screen.getByRole("link", { name: "Open version 2" });
    expect(link.getAttribute("href")).toBe(`#/documents/${DOC}/versions/${V2}`);
    expect(screen.queryByRole("link", { name: "Open version 1" })).toBeNull();
  });

  it("uploads the chosen file as a new version, says which number it became, and lists it", async () => {
    const state = { versions: [version(V1, 1)] };
    const fetchMock = mount(state);
    await screen.findByText(/Version 1/);

    fireEvent.change(screen.getByLabelText("New version (a file)"), {
      target: { files: [pdf("demo.pdf")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload as a new version" }));

    expect(await screen.findByText(/Uploaded as version 2/)).toBeTruthy();
    expect(await screen.findByText(/demo\.pdf/)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post[1].body.get("file").name).toBe("demo.pdf");
  });

  it("asks for a file first and sends nothing when none is chosen", async () => {
    const fetchMock = mount({ versions: [version(V1, 1)] });
    await screen.findByText(/Version 1/);

    fireEvent.click(screen.getByRole("button", { name: "Upload as a new version" }));

    expect(screen.getByRole("alert").textContent).toMatch(/choose a file/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("says why an upload was refused: already a version (409), too large (413), role (403)", async () => {
    for (const [status, pattern] of [
      [409, /already/i],
      [413, /50 MiB/i],
      [403, /cannot upload/i],
    ]) {
      const { unmount } = render(<span />);
      unmount();
      mount({ versions: [version(V1, 1)] }, { postStatus: status });
      await screen.findAllByText(/Version 1/);
      fireEvent.change(screen.getAllByLabelText("New version (a file)").at(-1), {
        target: { files: [pdf()] },
      });
      fireEvent.click(screen.getAllByRole("button", { name: "Upload as a new version" }).at(-1));
      const alerts = await screen.findAllByRole("alert");
      expect(alerts.at(-1).textContent).toMatch(pattern);
      document.body.innerHTML = "";
    }
  });

  it("downloads a version through the API with the token and offers the bytes as a file", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:x");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const fetchMock = mount({ versions: [version(V1, 1)] });
    await screen.findByText(/Version 1/);

    fireEvent.click(screen.getByRole("button", { name: "Download version 1" }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith("/content"));
    expect(call[0]).toBe(`/api/v1/documents/${DOC}/versions/${V1}/content`);
    expect(call[1].headers.Authorization).toBe("Bearer t0k");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("shows a version without a stored file as an error, not a crash, when its download is refused", async () => {
    const fetchMock = mount({ versions: [version(V1, 1)] });
    fetchMock.mockImplementation(async (url) =>
      url.endsWith("/content")
        ? new Response(JSON.stringify({ error: "Not found", code: "NOT_FOUND" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({ items: [version(V1, 1)] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
    );
    await screen.findByText(/Version 1/);

    fireEvent.click(screen.getByRole("button", { name: "Download version 1" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /no stored file|could not download/i,
    );
  });

  it("shows an error when the list cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Forbidden", code: "FORBIDDEN" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    render(<VersionsPanel token="t0k" documentId={DOC} versionId={V1} />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not load/i);
  });
});
