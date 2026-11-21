// Render test: the document view shows one version's comments, with download and versions still disabled until #116.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocumentPage from "./DocumentPage.jsx";

const USER = { id: "u1", displayName: "Ann" };
const DOC = "11111111-1111-4111-8111-111111111111";
const VER = "22222222-2222-4222-8222-222222222222";

function renderPage() {
  const fetchMock = vi.fn().mockResolvedValue(
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
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/documents/${DOC}/versions/${VER}/comments`);
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

  it("keeps download and the version list disabled and marked after 24 Nov", async () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Download" }).disabled).toBe(true);
    expect(screen.getByRole("heading", { name: "Versions" })).toBeTruthy();
    expect(screen.getAllByText(/after 24 Nov/).length).toBeGreaterThan(0);
    await screen.findByText("No comments yet.");
  });
});
