// Render tests: upload and the list stay disabled until #116; a version can be opened by its ids (D28).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocumentsPage from "./DocumentsPage.jsx";

const DOC = "11111111-1111-4111-8111-111111111111";
const VER = "22222222-2222-4222-8222-222222222222";

describe("DocumentsPage", () => {
  it("shows upload and the list as disabled, marked after 24 Nov, and calls nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<DocumentsPage />);

    expect(screen.getByRole("heading", { name: "Documents" })).toBeTruthy();
    expect(screen.getByLabelText("File").disabled).toBe(true);
    expect(screen.getByLabelText("Title").disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Upload" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Load more" }).disabled).toBe(true);
    expect(screen.getAllByText(/after 24 Nov/).length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens a version by its document id and version id", () => {
    render(<DocumentsPage />);

    fireEvent.change(screen.getByLabelText("Document id"), { target: { value: ` ${DOC} ` } });
    fireEvent.change(screen.getByLabelText("Version id"), { target: { value: VER } });
    fireEvent.click(screen.getByRole("button", { name: "Open version" }));

    expect(window.location.hash).toBe(`#/documents/${DOC}/versions/${VER}`);
  });

  it("refuses ids that are not ids, says so, and leaves the address alone", () => {
    render(<DocumentsPage />);

    fireEvent.change(screen.getByLabelText("Document id"), { target: { value: "nope" } });
    fireEvent.change(screen.getByLabelText("Version id"), { target: { value: VER } });
    fireEvent.click(screen.getByRole("button", { name: "Open version" }));

    expect(screen.getByRole("alert").textContent).toMatch(/ids/i);
    expect(window.location.hash).toBe("");
  });
});
