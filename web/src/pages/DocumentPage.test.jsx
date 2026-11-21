// Render test: the document view shows download, versions and comments as disabled until the routes land.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocumentPage from "./DocumentPage.jsx";

describe("DocumentPage", () => {
  it("shows download and comments as disabled, marked after 24 Nov, and calls nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<DocumentPage />);

    expect(screen.getByRole("heading", { name: "Document" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" }).disabled).toBe(true);
    expect(screen.getByLabelText("Comment").disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Add comment" }).disabled).toBe(true);
    expect(screen.getByRole("heading", { name: "Versions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Comments" })).toBeTruthy();
    expect(screen.getAllByText(/after 24 Nov/).length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
