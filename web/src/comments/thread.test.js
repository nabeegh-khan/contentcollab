// Tests for the pure comment helpers: applying a live event, grouping replies under roots, finding mentions (D28).
import { describe, expect, it } from "vitest";
import { applyEvent, authorLabel, buildThreads, splitMentions } from "./thread.js";

function comment(id, extra = {}) {
  return {
    id,
    versionId: "v1",
    authorId: "aaaaaaaa-1111-4111-8111-111111111111",
    parentId: null,
    body: `body ${id}`,
    anchor: null,
    resolved: false,
    createdAt: "2026-11-21T15:00:00.000Z",
    updatedAt: "2026-11-21T15:00:00.000Z",
    ...extra,
  };
}

describe("applyEvent", () => {
  it("appends a created comment", () => {
    const next = applyEvent([comment("c1")], "comment:created", comment("c2"));
    expect(next.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("does not show a comment twice when its own POST answer and its event both arrive", () => {
    const once = applyEvent([comment("c1")], "comment:created", comment("c2"));
    const twice = applyEvent(once, "comment:created", comment("c2"));
    expect(twice.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("replaces an updated comment in place and keeps the order", () => {
    const list = [comment("c1"), comment("c2"), comment("c3")];
    const next = applyEvent(list, "comment:updated", comment("c2", { body: "edited" }));
    expect(next.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(next[1].body).toBe("edited");
  });

  it("applies a resolve on a thread root to the root and shows replies as resolved too", () => {
    const list = [comment("c1"), comment("c2", { parentId: "c1" })];
    const next = applyEvent(list, "comment:updated", comment("c1", { resolved: true }));
    expect(next.find((c) => c.id === "c1").resolved).toBe(true);
    expect(next.find((c) => c.id === "c2").resolved).toBe(true);
  });

  it("adds an updated comment it has not seen (a missed create)", () => {
    const next = applyEvent([comment("c1")], "comment:updated", comment("c9"));
    expect(next.map((c) => c.id)).toEqual(["c1", "c9"]);
  });

  it("removes a deleted comment and the replies under it", () => {
    const list = [
      comment("c1"),
      comment("c2", { parentId: "c1" }),
      comment("c3", { parentId: "c2" }),
      comment("c4"),
    ];
    const next = applyEvent(list, "comment:deleted", { id: "c1" });
    expect(next.map((c) => c.id)).toEqual(["c4"]);
  });

  it("ignores a delete for an id it does not have, and unknown events", () => {
    const list = [comment("c1")];
    expect(applyEvent(list, "comment:deleted", { id: "zzz" })).toEqual(list);
    expect(applyEvent(list, "something:else", { id: "c1" })).toEqual(list);
  });

  it("never changes the list it was given", () => {
    const list = Object.freeze([comment("c1")]);
    expect(() => applyEvent(list, "comment:created", comment("c2"))).not.toThrow();
  });
});

describe("buildThreads", () => {
  it("returns roots in order, each with its replies in order, at any depth", () => {
    const list = [
      comment("c1"),
      comment("c2"),
      comment("c3", { parentId: "c1" }),
      comment("c4", { parentId: "c3" }),
      comment("c5", { parentId: "c2" }),
    ];
    const threads = buildThreads(list);
    expect(threads.map((t) => t.root.id)).toEqual(["c1", "c2"]);
    expect(threads[0].replies.map((c) => c.id)).toEqual(["c3", "c4"]);
    expect(threads[1].replies.map((c) => c.id)).toEqual(["c5"]);
  });

  it("treats a reply whose parent is missing as its own root, so nothing disappears", () => {
    const threads = buildThreads([comment("c2", { parentId: "gone" })]);
    expect(threads.map((t) => t.root.id)).toEqual(["c2"]);
  });

  it("returns no threads for no comments", () => {
    expect(buildThreads([])).toEqual([]);
  });
});

describe("splitMentions", () => {
  it("splits a body into text and mention parts, in order", () => {
    expect(splitMentions("hi @Ann and @bob.k, thanks")).toEqual([
      { type: "text", text: "hi " },
      { type: "mention", text: "@Ann" },
      { type: "text", text: " and " },
      { type: "mention", text: "@bob.k" },
      { type: "text", text: ", thanks" },
    ]);
  });

  it("returns one text part when there is no mention", () => {
    expect(splitMentions("plain <b>text</b>")).toEqual([
      { type: "text", text: "plain <b>text</b>" },
    ]);
  });

  it("returns no parts for an empty body", () => {
    expect(splitMentions("")).toEqual([]);
  });

  it("works twice in a row (no state left in the pattern)", () => {
    expect(splitMentions("@a")).toEqual(splitMentions("@a"));
  });
});

describe("authorLabel", () => {
  it("says You for the signed-in user and Member plus 8 characters for anyone else", () => {
    expect(authorLabel("abcdef12-0000", "abcdef12-0000")).toBe("You");
    expect(authorLabel("abcdef12-3456-7890", "someone-else")).toBe("Member abcdef12");
  });

  it("copes with a missing id", () => {
    expect(authorLabel(undefined, "me")).toBe("Member");
  });
});
