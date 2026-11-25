// Several files at once on the documents page: a drop of three files makes three uploads, a refused file does not block the others (D40, #190).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocumentsPage from "./DocumentsPage.jsx";

const pdf = (name) => new File(["%PDF-1.4"], name, { type: "application/pdf" });
const carrying = (files) => ({ dataTransfer: { files, types: ["Files"] } });

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /documents answers an empty list; every POST creates a document titled after its file
// (or the title field), unless `refuse` names the file the API should refuse with a status
function server({ refuse = {} } = {}) {
  const posts = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    if ((init.method ?? "GET") !== "POST") return reply(200, { items: [], nextCursor: null });
    const file = init.body.get("file");
    posts.push({ name: file.name, title: init.body.get("title") });
    if (refuse[file.name]) return reply(refuse[file.name], { error: "refused", code: "X" });
    return reply(201, {
      id: `id-${file.name}`,
      title: init.body.get("title") || file.name,
      ownerId: "u-1",
      currentVersionId: "v-1",
      role: "owner",
      tags: [],
      createdAt: "2026-11-25T15:00:00.000Z",
      updatedAt: "2026-11-25T15:00:00.000Z",
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posts };
}

async function mount(options) {
  const made = server(options);
  render(<DocumentsPage token="t0k" />);
  await screen.findByText(/no documents yet/i);
  return { ...made, zone: screen.getByRole("group", { name: /drop files/i }) };
}

describe("DocumentsPage: drop several files", () => {
  it("makes three uploads for a drop of three files, each with its own result line", async () => {
    const { posts, zone } = await mount();

    fireEvent.drop(zone, carrying([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]));

    await waitFor(() =>
      expect(posts.map((p) => p.name).sort()).toEqual(["a.pdf", "b.pdf", "c.pdf"]),
    );
    const list = await screen.findByRole("list", { name: /uploads/i });
    await waitFor(() => expect(within(list).getAllByText(/Uploaded/).length).toBe(3));
    for (const name of ["a.pdf", "b.pdf", "c.pdf"]) {
      expect(within(list).getByText(name)).toBeTruthy();
    }
  });

  it("shows a refused file's message beside it, does not send it, and still uploads the others", async () => {
    const { posts, zone } = await mount();
    const bad = new File(["MZ"], "setup.exe", { type: "application/octet-stream" });

    fireEvent.drop(zone, carrying([pdf("a.pdf"), bad, pdf("c.pdf")]));

    const list = await screen.findByRole("list", { name: /uploads/i });
    await waitFor(() => expect(within(list).getAllByText(/Uploaded/).length).toBe(2));
    expect(posts.map((p) => p.name).sort()).toEqual(["a.pdf", "c.pdf"]);
    const row = within(list).getByText("setup.exe").closest("li");
    expect(within(row).getByText(/not allowed/i)).toBeTruthy();
  });

  it("shows the API's refusal for one file and keeps the rest going", async () => {
    const { zone } = await mount({ refuse: { "b.pdf": 413 } });

    fireEvent.drop(zone, carrying([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]));

    const list = await screen.findByRole("list", { name: /uploads/i });
    await waitFor(() => expect(within(list).getAllByText(/Uploaded/).length).toBe(2));
    const row = within(list).getByText("b.pdf").closest("li");
    expect(within(row).getByText(/too large/i)).toBeTruthy();
  });

  it("refreshes the documents list after a drop", async () => {
    const { fetchMock, zone } = await mount();
    const listCalls = () =>
      fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === "GET").length;
    const before = listCalls();

    fireEvent.drop(zone, carrying([pdf("a.pdf"), pdf("b.pdf")]));

    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });

  it("takes several files from the picker too, and uses the title only for a single file", async () => {
    const { posts } = await mount();
    const input = screen.getByLabelText("File");
    expect(input.multiple).toBe(true);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My title" } });

    fireEvent.change(input, { target: { files: [pdf("a.pdf"), pdf("b.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts.map((p) => p.title)).toEqual([null, null]);
  });

  it("still sends the title with a single file from the picker", async () => {
    const { posts } = await mount();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My title" } });
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [pdf("a.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(posts).toEqual([{ name: "a.pdf", title: "My title" }]));
  });

  it("takes no second drop while the first is still uploading", async () => {
    const { fetchMock, zone } = await mount();
    let release;
    fetchMock.mockImplementation(
      (url, init = {}) =>
        new Promise((resolve) => {
          if ((init.method ?? "GET") !== "POST")
            return resolve(reply(200, { items: [], nextCursor: null }));
          release = () => resolve(reply(201, { id: "d", title: "t", role: "owner" }));
        }),
    );
    fireEvent.drop(zone, carrying([pdf("a.pdf")]));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const posts = () => fetchMock.mock.calls.filter(([, i]) => i?.method === "POST").length;
    expect(posts()).toBe(1);

    fireEvent.drop(zone, carrying([pdf("b.pdf")]));
    expect(posts()).toBe(1);
    release();
  });

  it("stays busy until the list reload after the batch has finished", async () => {
    const { fetchMock, zone } = await mount();
    let releaseList;
    fetchMock.mockImplementation(async (url, init = {}) => {
      if ((init.method ?? "GET") === "POST")
        return reply(201, { id: "d", title: "t", role: "owner" });
      await new Promise((resolve) => {
        releaseList = resolve;
      });
      return reply(200, { items: [], nextCursor: null });
    });
    fireEvent.drop(zone, carrying([pdf("a.pdf")]));
    await waitFor(() => expect(releaseList).toBeTypeOf("function"));

    expect(screen.getByRole("button", { name: "Upload" }).disabled).toBe(true);
    expect(zone.getAttribute("aria-disabled")).toBe("true");
    releaseList();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload" }).disabled).toBe(false),
    );
  });
});
