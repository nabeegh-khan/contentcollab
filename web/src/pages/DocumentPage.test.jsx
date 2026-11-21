// Render test: the document view shows the document's versions (list, upload) and one version's comments.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocumentPage from "./DocumentPage.jsx";

const USER = { id: "u1", displayName: "Ann" };
const DOC = "11111111-1111-4111-8111-111111111111";
const VER = "22222222-2222-4222-8222-222222222222";

function renderPage() {
  // A new Response for every call: a body can be read only once
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const connect = vi.fn().mockReturnValue({ close: vi.fn() });
  render(
    <DocumentPage token="t0k" user={USER} documentId={DOC} versionId={VER} connect={connect} />,
  );
  return { fetchMock, connect };
}

describe("DocumentPage", () => {
  it("loads the comments of the version in the address, with the token", async () => {
    const { fetchMock, connect } = renderPage();

    expect(await screen.findByText("No comments yet.")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls.find(([u]) => u.includes("/comments"));
    expect(url).toBe(`/api/v1/documents/${DOC}/versions/${VER}/comments?limit=100`);
    expect(init.headers.Authorization).toBe("Bearer t0k");
    expect(connect.mock.calls[0][0]).toMatchObject({ token: "t0k", versionId: VER });
  });

  it("shows the document heading, a way back to the documents page, and the comment form", async () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Document" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to documents" }).getAttribute("href")).toBe("#/");
    expect(await screen.findByLabelText("Comment")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add comment" })).toBeTruthy();
  });

  it("shows the versions of the document with an upload control, and no 'after 24 Nov' placeholder", async () => {
    const { fetchMock } = renderPage();

    expect(screen.getByRole("heading", { name: "Versions" })).toBeTruthy();
    expect(screen.getByLabelText("New version (a file)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload as a new version" })).toBeTruthy();
    expect(screen.queryByText(/after 24 Nov/)).toBeNull();
    await screen.findByText("No comments yet.");
    const versionsCall = fetchMock.mock.calls.find(
      ([u]) => u === `/api/v1/documents/${DOC}/versions`,
    );
    expect(versionsCall[1].headers.Authorization).toBe("Bearer t0k");
  });
});
