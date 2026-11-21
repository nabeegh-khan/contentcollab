// Render test: the documents page shows its list and upload as disabled until the routes land.
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("shows the share form and sends the page's token with it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "s1", role: "viewer" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage token="t0k" />);

    expect(screen.getByRole("heading", { name: "Share a document" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Document id"), {
      target: { value: "11111111-1111-4111-8111-111111111111" },
    });
    fireEvent.change(screen.getByLabelText("Email of the user"), { target: { value: "a@b.co" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await screen.findByText("Shared with a@b.co as viewer.");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
  });
});
