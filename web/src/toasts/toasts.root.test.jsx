// The root mounts the toast list for every page, signed in or not (D40, #192).
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Root from "../Root.jsx";

describe("Root and the toast list", () => {
  it("mounts a polite Notifications region", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<Root />);

    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region.getAttribute("aria-live")).toBe("polite");
  });
});
