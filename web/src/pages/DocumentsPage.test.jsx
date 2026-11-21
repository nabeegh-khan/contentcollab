// Render test: the documents page shows its list and upload as disabled until the routes land.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocumentsPage from "./DocumentsPage.jsx";

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
});
