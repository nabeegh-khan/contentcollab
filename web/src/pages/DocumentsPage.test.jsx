// Render tests for the documents page: the real list (#116), Load more, an empty and an error state, and upload.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocumentsPage from "./DocumentsPage.jsx";

const D1 = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const D2 = "33333333-3333-4333-8333-333333333333";
const V2 = "44444444-4444-4444-8444-444444444444";

function doc(id, versionId, title, extra = {}) {
  return {
    id,
    title,
    ownerId: "u-1",
    currentVersionId: versionId,
    role: "owner",
    tags: [],
    createdAt: "2026-11-21T15:00:00.000Z",
    updatedAt: "2026-11-21T21:52:00.000Z",
    ...extra,
  };
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// pages: the answers to successive GET /documents calls (a page, or { status, body } for a refusal);
// post: [status, body] for POST /documents
function server({
  pages = [{ items: [], nextCursor: null }],
  post = [201, doc(D2, V2, "New")],
} = {}) {
  let next = 0;
  const fetchMock = vi.fn(async (url, init = {}) => {
    if ((init.method ?? "GET") === "POST") return reply(...post);
    const page = pages[Math.min(next, pages.length - 1)];
    next += 1;
    if (typeof page.status === "number") return reply(page.status, page.body);
    return reply(200, page);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("DocumentsPage list", () => {
  it("lists the documents with title, role, updated time and a link to the latest version", async () => {
    const fetchMock = server({
      pages: [{ items: [doc(D1, V1, "Q4 report")], nextCursor: null }],
    });

    render(<DocumentsPage token="t0k" />);

    const link = await screen.findByRole("link", { name: "Open Q4 report" });
    expect(link.getAttribute("href")).toBe(`#/documents/${D1}/versions/${V1}`);
    const row = link.closest("li");
    expect(within(row).getByText("Q4 report")).toBeTruthy();
    expect(within(row).getByText(/owner/i)).toBeTruthy();
    expect(within(row).getByText(/Updated/)).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/documents?limit=20");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
  });

  it("no longer shows the placeholder or the open-by-ids box", async () => {
    server({ pages: [{ items: [doc(D1, V1, "A")], nextCursor: null }] });

    render(<DocumentsPage token="t0k" />);
    await screen.findByRole("link", { name: "Open A" });

    expect(screen.queryByText(/after 24 Nov/)).toBeNull();
    expect(screen.queryByText(/by its ids/)).toBeNull();
    expect(screen.queryByLabelText("Document id")).toBeNull();
    expect(screen.getByLabelText("File").disabled).toBe(false);
  });

  it("says so when the user has no documents", async () => {
    server();

    render(<DocumentsPage token="t0k" />);

    expect(await screen.findByText(/You have no documents yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows an error, not an empty list, when the list cannot be loaded", async () => {
    server({ pages: [{ status: 500, body: { error: "boom", code: "INTERNAL" } }] });

    render(<DocumentsPage token="t0k" />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not load your documents/);
    expect(screen.queryByText(/You have no documents yet/)).toBeNull();
  });

  it("loads the next page with the cursor and appends it, hiding Load more at the end", async () => {
    const fetchMock = server({
      pages: [
        { items: [doc(D1, V1, "First")], nextCursor: "cur 1" },
        { items: [doc(D2, V2, "Second")], nextCursor: null },
      ],
    });

    render(<DocumentsPage token="t0k" />);
    await screen.findByRole("link", { name: "Open First" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await screen.findByRole("link", { name: "Open Second" });
    expect(screen.getByRole("link", { name: "Open First" })).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/documents?limit=20&cursor=cur%201");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("DocumentsPage upload", () => {
  function choose(file, title) {
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [file] } });
    if (title !== undefined)
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: title } });
  }

  it("uploads the file with its title, says so, and shows the new document in the list", async () => {
    const fetchMock = server({
      pages: [
        { items: [], nextCursor: null },
        { items: [doc(D2, V2, "Plan")], nextCursor: null },
      ],
      post: [201, doc(D2, V2, "Plan")],
    });
    render(<DocumentsPage token="t0k" />);
    await screen.findByText(/You have no documents yet/);

    choose(new File(["x"], "plan.pdf", { type: "application/pdf" }), "Plan");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/Uploaded .*Plan/);
    await screen.findByRole("link", { name: "Open Plan" });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post[0]).toBe("/api/v1/documents");
    expect(post[1].body.get("file").name).toBe("plan.pdf");
    expect(post[1].body.get("title")).toBe("Plan");
  });

  it("asks for a file first and sends nothing when none is chosen", async () => {
    const fetchMock = server();
    render(<DocumentsPage token="t0k" />);
    await screen.findByText(/You have no documents yet/);

    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(screen.getByRole("alert").textContent).toMatch(/Choose a file first/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("explains a refused upload (too large) and keeps the list", async () => {
    server({
      pages: [{ items: [doc(D1, V1, "Keep")], nextCursor: null }],
      post: [413, { error: "too big", code: "PAYLOAD_TOO_LARGE" }],
    });
    render(<DocumentsPage token="t0k" />);
    await screen.findByRole("link", { name: "Open Keep" });

    choose(new File(["x"], "big.pdf"));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/too large/));
    expect(screen.getByRole("link", { name: "Open Keep" })).toBeTruthy();
  });

  it("names the allowed file types for a refused type, and only offers those in the picker", async () => {
    server({ post: [400, { error: "type", code: "UNSUPPORTED" }] });
    render(<DocumentsPage token="t0k" />);
    await screen.findByText(/You have no documents yet/);
    expect(screen.getByLabelText("File").getAttribute("accept")).toBe(
      ".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx,.txt,.md",
    );

    choose(new File(["x"], "pic.gif"));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/\.pdf.*\.md/));
  });

  it("shows the API's own message for a validation refusal such as a title that is too long", async () => {
    server({
      post: [
        400,
        {
          error: "Invalid Request",
          code: "VALIDATION",
          details: [
            { field: "title", message: "Too big: expected string to have <=255 characters" },
          ],
        },
      ],
    });
    render(<DocumentsPage token="t0k" />);
    await screen.findByText(/You have no documents yet/);

    choose(new File(["x"], "a.pdf"), "x".repeat(300));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/<=255/));
  });

  it("keeps the list and the success message when the reload after an upload fails", async () => {
    server({
      pages: [
        { items: [doc(D1, V1, "Keep")], nextCursor: null },
        { status: 500, body: { error: "boom", code: "INTERNAL" } },
      ],
      post: [201, doc(D2, V2, "Plan")],
    });
    render(<DocumentsPage token="t0k" />);
    await screen.findByRole("link", { name: "Open Keep" });

    choose(new File(["x"], "plan.pdf"), "Plan");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await screen.findByRole("status");
    expect(screen.getByRole("link", { name: "Open Keep" })).toBeTruthy();
    expect(screen.queryByText(/Could not load your documents/)).toBeNull();
  });
});

describe("DocumentsPage edge cases", () => {
  it("shows no link for a document without a current version", async () => {
    server({ pages: [{ items: [doc(D1, null, "Empty shell")], nextCursor: null }] });

    render(<DocumentsPage token="t0k" />);

    const row = (await screen.findByText("Empty shell")).closest("li");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).getByText(/No version yet/)).toBeTruthy();
  });

  it("sends one request for a double click on Load more, and shows an error if it fails", async () => {
    const fetchMock = server({
      pages: [
        { items: [doc(D1, V1, "First")], nextCursor: "c1" },
        { status: 500, body: { error: "boom", code: "INTERNAL" } },
      ],
    });
    render(<DocumentsPage token="t0k" />);
    await screen.findByRole("link", { name: "Open First" });

    const more = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(more);
    fireEvent.click(more);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Could not load more/),
    );
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("cursor=c1"))).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open First" })).toBeTruthy();
  });

  it("shows the share form and sends the page's token with it", async () => {
    // the page lists documents first (GET /documents), then the form posts the share
    const answer = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const fetchMock = vi.fn(async (url) =>
      String(url).includes("/shares")
        ? answer(201, { id: "s1", role: "viewer" })
        : answer(200, { items: [], nextCursor: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage token="t0k" />);

    expect(screen.getByRole("heading", { name: "Share a document" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Id of the document to share"), {
      target: { value: "11111111-1111-4111-8111-111111111111" },
    });
    fireEvent.change(screen.getByLabelText("Email of the user"), { target: { value: "a@b.co" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await screen.findByText("Shared with a@b.co as viewer.");
    const post = fetchMock.mock.calls.find(([url]) => String(url).includes("/shares"));
    expect(post[1].headers.Authorization).toBe("Bearer t0k");
  });
});

describe("DocumentsPage sharing from the list", () => {
  it("offers Share on the documents the user owns, and puts that document's id in the share form", async () => {
    server({
      pages: [
        {
          items: [doc(D1, V1, "Mine"), doc(D2, V2, "Theirs", { role: "commenter" })],
          nextCursor: null,
        },
      ],
    });
    render(<DocumentsPage token="t0k" />);
    await screen.findByRole("link", { name: "Open Mine" });

    expect(screen.queryByRole("button", { name: "Share Theirs" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share Mine" }));

    expect(screen.getByLabelText("Id of the document to share").value).toBe(D1);
  });
});
