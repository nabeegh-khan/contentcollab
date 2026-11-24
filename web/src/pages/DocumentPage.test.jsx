// Render test: the document view shows the document's versions (list, upload) and one version's comments.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocumentPage from "./DocumentPage.jsx";

const USER = { id: "u1", displayName: "Ann" };
const DOC = "11111111-1111-4111-8111-111111111111";
const VER = "22222222-2222-4222-8222-222222222222";

function renderPage({ document: doc = { id: DOC, title: "Design review draft" } } = {}) {
  // A new Response for every call: a body can be read only once. The document itself has its own route.
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchMock = vi.fn().mockImplementation(async (url) => {
    if (url === `/api/v1/documents/${DOC}`) {
      return doc === null
        ? json(404, { error: "Document Not Found", code: "NOT_FOUND" })
        : json(200, doc);
    }
    return json(200, { items: [], nextCursor: null });
  });
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

    expect(await screen.findByRole("heading", { name: "Design review draft" })).toBeTruthy();
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

  it("reads the document's title with the token, and shows it as text, never as HTML", async () => {
    const { fetchMock } = renderPage({ document: { id: DOC, title: "<b>Plan</b> v2" } });

    expect(await screen.findByRole("heading", { name: "<b>Plan</b> v2" })).toBeTruthy();
    const call = fetchMock.mock.calls.find(([u]) => u === `/api/v1/documents/${DOC}`);
    expect(call[1].headers.Authorization).toBe("Bearer t0k");
    expect(document.querySelector("h2 b")).toBeNull();
  });

  it("falls back to the plain heading Document while the title loads or when it cannot be read", async () => {
    renderPage({ document: null });

    expect(screen.getByRole("heading", { name: "Document" })).toBeTruthy();
    await screen.findByText("No comments yet.");
    expect(screen.getByRole("heading", { name: "Document" })).toBeTruthy();
  });
});
