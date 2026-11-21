// Each comment shows its own created time, to the minute, with the relative time beside it (not one shared timestamp).
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CommentsPanel from "./CommentsPanel.jsx";

const ME = { id: "u1", displayName: "Ann" };

function comment(id, createdAt) {
  return {
    id,
    versionId: "v1",
    authorId: "u2",
    parentId: null,
    body: `body ${id}`,
    anchor: null,
    resolved: false,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("comment times", () => {
  it("shows a different clock and relative time on each comment, from its own createdAt", async () => {
    const now = Date.now();
    const twoMinAgo = new Date(now - 2 * 60 * 1000).toISOString();
    const threeHoursAgo = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              items: [comment("c1", threeHoursAgo), comment("c2", twoMinAgo)],
              nextCursor: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const connect = vi.fn().mockReturnValue({ close: vi.fn() });

    render(
      <CommentsPanel token="t0k" user={ME} documentId="d1" versionId="v1" connect={connect} />,
    );

    await screen.findByText("body c1");
    const times = [...document.querySelectorAll("time")].map((t) => t.textContent);
    expect(times).toHaveLength(2);
    expect(times[0]).toMatch(/^\d{1,2}:\d{2} (AM|PM), \d{1,2} \w{3} \(3 h ago\)$/);
    expect(times[1]).toMatch(/^\d{1,2}:\d{2} (AM|PM), \d{1,2} \w{3} \(2 min ago\)$/);
    expect(times[0].split(" (")[0]).not.toBe(times[1].split(" (")[0]);
    expect(document.querySelector("time").getAttribute("datetime")).toBe(threeHoursAgo);
  });
});
