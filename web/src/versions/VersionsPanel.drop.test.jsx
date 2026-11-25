// Several files at once in the versions panel: each becomes a version, one at a time in drop order (D40, #190).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VersionsPanel from "./VersionsPanel.jsx";

const DOC = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";

const pdf = (name) => new File(["%PDF-1.4"], name, { type: "application/pdf" });
const carrying = (files) => ({ dataTransfer: { files, types: ["Files"] } });

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function version(number, filename) {
  return {
    id: `v-${number}`,
    documentId: DOC,
    number,
    filename,
    contentType: "application/pdf",
    size: 8,
  };
}

// Versions are numbered as their POST arrives; `inFlight` shows whether two POSTs ever overlapped,
// and `refuse` names a file the API refuses with a status
function server({ refuse = {} } = {}) {
  const versions = [version(1, "first.pdf")];
  const order = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = vi.fn(async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") return reply(200, { items: versions });
    const file = init.body.get("file");
    order.push(file.name);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    if (refuse[file.name]) return reply(refuse[file.name], { error: "refused", code: "X" });
    const created = version(versions.length + 1, file.name);
    versions.push(created);
    return reply(201, created);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { order, maxInFlight: () => maxInFlight };
}

async function mount(options) {
  const made = server(options);
  render(<VersionsPanel token="t0k" documentId={DOC} versionId={V1} />);
  await screen.findByText(/Version 1: first.pdf/);
  return { ...made, zone: screen.getByRole("group", { name: /drop files/i }) };
}

describe("VersionsPanel: drop several files", () => {
  it("makes one version per file, one request at a time, in the order the files were dropped", async () => {
    const { order, maxInFlight, zone } = await mount();

    fireEvent.drop(zone, carrying([pdf("c.pdf"), pdf("a.pdf"), pdf("b.pdf")]));

    const list = await screen.findByRole("list", { name: /uploads/i });
    await waitFor(() => expect(within(list).getAllByText(/Uploaded as version/).length).toBe(3));
    expect(order).toEqual(["c.pdf", "a.pdf", "b.pdf"]);
    expect(maxInFlight()).toBe(1);
    // the version numbers follow the drop order
    expect(within(list).getByText("c.pdf").closest("li").textContent).toMatch(/version 2/);
    expect(within(list).getByText("a.pdf").closest("li").textContent).toMatch(/version 3/);
    expect(within(list).getByText("b.pdf").closest("li").textContent).toMatch(/version 4/);
  });

  it("shows a too-large file's message, does not send it, and uploads the others", async () => {
    const { order, zone } = await mount();
    const huge = pdf("huge.pdf");
    Object.defineProperty(huge, "size", { value: 50 * 1024 * 1024 + 1 });

    fireEvent.drop(zone, carrying([pdf("a.pdf"), huge, pdf("c.pdf")]));

    const list = await screen.findByRole("list", { name: /uploads/i });
    await waitFor(() => expect(within(list).getAllByText(/Uploaded as version/).length).toBe(2));
    expect(order).toEqual(["a.pdf", "c.pdf"]);
    expect(
      within(within(list).getByText("huge.pdf").closest("li")).getByText(/too large/i),
    ).toBeTruthy();
  });

  it("says a duplicate is already a version (409) for that file only", async () => {
    const { zone } = await mount({ refuse: { "dup.pdf": 409 } });

    fireEvent.drop(zone, carrying([pdf("dup.pdf"), pdf("new.pdf")]));

    const list = await screen.findByRole("list", { name: /uploads/i });
    await waitFor(() => expect(within(list).getAllByText(/Uploaded as version/).length).toBe(1));
    expect(
      within(within(list).getByText("dup.pdf").closest("li")).getByText(/already a version/i),
    ).toBeTruthy();
  });

  it("reloads the version list after the drop", async () => {
    const { zone } = await mount();
    fireEvent.drop(zone, carrying([pdf("a.pdf"), pdf("b.pdf")]));
    expect(await screen.findByText(/Version 3: b.pdf/)).toBeTruthy();
  });

  it("keeps the picker: several files from it become several versions", async () => {
    const { order } = await mount();
    const input = screen.getByLabelText("New version (a file)");
    expect(input.multiple).toBe(true);

    fireEvent.change(input, { target: { files: [pdf("a.pdf"), pdf("b.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload as a new version" }));

    await waitFor(() => expect(order).toEqual(["a.pdf", "b.pdf"]));
  });
});
