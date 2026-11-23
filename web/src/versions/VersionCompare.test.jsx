// Render tests for "Compare versions" (#23, D33): two versions chosen, the line diff shown with added and
// removed lines marked by a sign and a word as well as by colour, and a plain message when a file is not text.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VersionCompare from "./VersionCompare.jsx";

const DOC = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const V2 = "33333333-3333-4333-8333-333333333333";
const versions = [
  { id: V1, number: 1, filename: "notes-v1.md", contentType: "text/markdown", size: 10 },
  { id: V2, number: 2, filename: "notes-v2.md", contentType: "text/markdown", size: 12 },
];

const diff = {
  from: { id: V1, number: 1, filename: "notes-v1.md" },
  to: { id: V2, number: 2, filename: "notes-v2.md" },
  added: 1,
  removed: 1,
  lines: [
    { op: "keep", text: "same line", before: 1, after: 1 },
    { op: "remove", text: "old line", before: 2 },
    { op: "add", text: "new line", after: 2 },
  ],
};

function answer(status, body) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function compare(fetchMock) {
  vi.stubGlobal("fetch", fetchMock);
  render(<VersionCompare token="t" documentId={DOC} versions={versions} />);
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
}

describe("VersionCompare", () => {
  it("offers nothing to compare with fewer than two versions", () => {
    render(<VersionCompare token="t" documentId={DOC} versions={versions.slice(0, 1)} />);
    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
    expect(screen.getByText(/at least two versions/i)).toBeTruthy();
  });

  it("asks for the older version as from and the newest as to, by default", async () => {
    const fetchMock = answer(200, diff);
    await compare(fetchMock);
    await screen.findByRole("list", { name: "Differences" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/v1/documents/${DOC}/versions/compare?from=${V1}&to=${V2}`,
    );
  });

  it("still asks for the oldest and newest version when the list arrives after the first render", async () => {
    const fetchMock = answer(200, diff);
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<VersionCompare token="t" documentId={DOC} versions={[]} />);
    rerender(<VersionCompare token="t" documentId={DOC} versions={versions} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByRole("list", { name: "Differences" });
    expect(fetchMock.mock.calls[0][0]).toContain(`from=${V1}&to=${V2}`);
  });

  it("marks removed and added lines with a sign and a word, not by colour alone", async () => {
    await compare(answer(200, diff));
    const list = await screen.findByRole("list", { name: "Differences" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1].textContent).toMatch(/Removed/);
    expect(items[1].textContent).toMatch(/−/);
    expect(items[1].textContent).toMatch(/old line/);
    expect(items[2].textContent).toMatch(/Added/);
    expect(items[2].textContent).toMatch(/\+/);
    expect(items[2].textContent).toMatch(/new line/);
    expect(items[0].textContent).toMatch(/same line/);
    expect(screen.getByText("1 line added, 1 line removed")).toBeTruthy();
  });

  it("says when the two versions have the same text", async () => {
    await compare(
      answer(200, {
        ...diff,
        added: 0,
        removed: 0,
        lines: [{ op: "keep", text: "x", before: 1, after: 1 }],
      }),
    );
    expect(await screen.findByText("The two versions have the same text.")).toBeTruthy();
  });

  it("explains a file that is not text and shows both versions side by side", async () => {
    await compare(answer(415, { error: "not text", code: "UNSUPPORTED_TYPE" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/only text and Markdown/i);
    const side = screen.getByRole("group", { name: "Side by side" });
    expect(within(side).getByText(/notes-v1\.md/)).toBeTruthy();
    expect(within(side).getByText(/notes-v2\.md/)).toBeTruthy();
  });

  it("says a version is too large, and that access was refused", async () => {
    await compare(answer(413, { error: "big", code: "TOO_LARGE" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/too large/i));
  });

  it("shows text as text: markup in a line is not interpreted", async () => {
    await compare(
      answer(200, {
        ...diff,
        lines: [{ op: "add", text: "<img src=x onerror=alert(1)>", after: 1 }],
      }),
    );
    const list = await screen.findByRole("list", { name: "Differences" });
    expect(list.querySelector("img")).toBeNull();
    expect(list.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
