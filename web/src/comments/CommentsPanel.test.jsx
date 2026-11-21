// Render tests for the comments panel: load, post, reply, resolve, delete, live events, mentions (D28).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CommentsPanel from "./CommentsPanel.jsx";

const ME = { id: "aaaaaaaa-1111-4111-8111-111111111111", displayName: "Ann" };
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222";
const DOC = "d-1";
const VER = "v-1";

function comment(id, extra = {}) {
  return {
    id,
    versionId: VER,
    authorId: OTHER,
    parentId: null,
    body: `body ${id}`,
    anchor: null,
    resolved: false,
    createdAt: "2026-11-21T15:00:00.000Z",
    updatedAt: "2026-11-21T15:00:00.000Z",
    ...extra,
  };
}

// Routes fetch by method and path; `state.comments` is what the server holds
function server(state, { postStatus = 201 } = {}) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method ?? "GET";
    const reply = (status, body) =>
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: body === null ? {} : { "Content-Type": "application/json" },
      });
    if (method === "GET" && url.includes("/comments")) {
      return reply(200, { items: state.comments, nextCursor: null });
    }
    if (method === "POST") {
      if (postStatus !== 201) return reply(postStatus, { error: "Forbidden", code: "FORBIDDEN" });
      const sent = JSON.parse(init.body);
      const created = comment("new1", {
        authorId: ME.id,
        body: sent.body,
        parentId: sent.parentId ?? null,
      });
      state.comments = [...state.comments, created];
      return reply(201, created);
    }
    if (method === "PATCH") {
      const sent = JSON.parse(init.body);
      const id = url.split("/").pop();
      state.comments = state.comments.map((c) => (c.id === id ? { ...c, ...sent } : c));
      return reply(
        200,
        state.comments.find((c) => c.id === id),
      );
    }
    if (method === "DELETE") {
      const id = url.split("/").pop();
      state.comments = state.comments.filter((c) => c.id !== id);
      return reply(204, null);
    }
    return reply(404, { error: "no route" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// A stand-in for connectVersion that keeps the handlers so a test can play the server
function fakeConnect() {
  const live = { handlers: null, close: vi.fn() };
  const connect = vi.fn((options) => {
    live.handlers = options;
    return { close: live.close };
  });
  return { connect, live };
}

function mount(state, extra = {}) {
  const fetchMock = server(state, extra.server);
  const { connect, live } = fakeConnect();
  render(
    <CommentsPanel token="t0k" user={ME} documentId={DOC} versionId={VER} connect={connect} />,
  );
  return { fetchMock, connect, live };
}

describe("CommentsPanel", () => {
  it("loads the version's comments, with You for the user and a short id for others", async () => {
    const state = { comments: [comment("c1"), comment("c2", { authorId: ME.id })] };
    mount(state);

    expect(await screen.findByText("body c1")).toBeTruthy();
    expect(screen.getByText("body c2")).toBeTruthy();
    expect(screen.getByText("Member bbbbbbbb")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
  });

  it("opens the live connection for this version with the token", async () => {
    const { connect } = mount({ comments: [] });
    await screen.findByText("No comments yet.");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0]).toMatchObject({ token: "t0k", versionId: VER });
  });

  it("shows a body as text, never as HTML, and marks @mentions", async () => {
    mount({ comments: [comment("c1", { body: "hi @Ann <b>bold</b>" })] });

    const mention = await screen.findByText("@Ann");
    expect(mention.tagName).toBe("STRONG");
    expect(mention.className).toContain("mention");
    expect(screen.getByText(/<b>bold<\/b>/)).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });

  it("posts a comment and shows it once, even when its own live event also arrives", async () => {
    const state = { comments: [] };
    const { fetchMock, live } = mount(state);
    await screen.findByText("No comments yet.");

    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "first!" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    expect(await screen.findByText("first!")).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post[1].body)).toEqual({ body: "first!" });
    expect(screen.getByLabelText("Comment").value).toBe("");

    act(() => live.handlers.onEvent("comment:created", state.comments[0]));
    expect(screen.getAllByText("first!")).toHaveLength(1);
  });

  it("does not post an empty comment", async () => {
    const { fetchMock } = mount({ comments: [] });
    await screen.findByText("No comments yet.");

    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("shows the API's refusal when the role cannot comment", async () => {
    mount({ comments: [] }, { server: { postStatus: 403 } });
    await screen.findByText("No comments yet.");

    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot comment/i);
    expect(screen.getByLabelText("Comment").value).toBe("hello");
  });

  it("replies under a comment with its parentId", async () => {
    const state = { comments: [comment("c1")] };
    const { fetchMock } = mount(state);
    await screen.findByText("body c1");

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "agreed" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    expect(await screen.findByText("agreed")).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post[1].body)).toEqual({ body: "agreed", parentId: "c1" });
  });

  it("offers Resolve only on threads the user started, as the API allows", async () => {
    const state = { comments: [comment("c1"), comment("c2", { authorId: ME.id })] };
    mount(state);
    await screen.findByText("body c2");

    expect(screen.getAllByRole("button", { name: "Resolve" })).toHaveLength(1);
  });

  it("resolves a thread through PATCH and shows it as resolved", async () => {
    const state = { comments: [comment("c1", { authorId: ME.id })] };
    const { fetchMock } = mount(state);
    await screen.findByText("body c1");

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(await screen.findByText("Resolved")).toBeTruthy();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch[0]).toBe(`/api/v1/documents/${DOC}/comments/c1`);
    expect(JSON.parse(patch[1].body)).toEqual({ resolved: true });
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("offers Delete on the user's own comments only, and removes the comment", async () => {
    const state = { comments: [comment("c1"), comment("c2", { authorId: ME.id })] };
    const { fetchMock } = mount(state);
    await screen.findByText("body c2");

    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("body c2")).toBeNull());
    expect(screen.getByText("body c1")).toBeTruthy();
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(del[0]).toBe(`/api/v1/documents/${DOC}/comments/c2`);
  });

  it("shows a comment that arrives live, and drops one deleted live", async () => {
    const { live } = mount({ comments: [comment("c1")] });
    await screen.findByText("body c1");

    act(() =>
      live.handlers.onEvent("comment:created", comment("c7", { body: "from the other tab" })),
    );
    expect(screen.getByText("from the other tab")).toBeTruthy();

    act(() => live.handlers.onEvent("comment:deleted", { id: "c7" }));
    expect(screen.queryByText("from the other tab")).toBeNull();
  });

  it("loads the list again after each accepted join, to fill any gap", async () => {
    const state = { comments: [comment("c1")] };
    const { fetchMock, live } = mount(state);
    await screen.findByText("body c1");
    const before = fetchMock.mock.calls.filter(([, i]) => (i?.method ?? "GET") === "GET").length;

    state.comments = [...state.comments, comment("c2", { body: "missed while offline" })];
    await act(async () => live.handlers.onJoined());

    expect(await screen.findByText("missed while offline")).toBeTruthy();
    const after = fetchMock.mock.calls.filter(([, i]) => (i?.method ?? "GET") === "GET").length;
    expect(after).toBe(before + 1);
  });

  it("shows the live state, and a notice when someone mentions the user", async () => {
    const { live } = mount({ comments: [] });
    await screen.findByText("No comments yet.");

    act(() => live.handlers.onState("live"));
    expect(screen.getByRole("status").textContent).toMatch(/live/i);

    act(() => live.handlers.onState("reconnecting"));
    expect(screen.getByRole("status").textContent).toMatch(/reconnecting/i);

    act(() => live.handlers.onMention({ commentId: "c9", documentId: DOC, from: OTHER }));
    expect(screen.getByText(/mentioned you/i)).toBeTruthy();
  });

  it("shows an error when the comments cannot be loaded, and still closes the connection on unmount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Forbidden", code: "FORBIDDEN" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const { connect, live } = fakeConnect();
    const { unmount } = render(
      <CommentsPanel token="t0k" user={ME} documentId={DOC} versionId={VER} connect={connect} />,
    );

    expect((await screen.findAllByRole("alert"))[0].textContent).toMatch(/could not load/i);
    unmount();
    expect(live.close).toHaveBeenCalledTimes(1);
  });

  it("keeps each thread's replies inside that thread", async () => {
    const state = {
      comments: [
        comment("c1"),
        comment("c2"),
        comment("c3", { parentId: "c1", body: "reply to c1" }),
      ],
    };
    mount(state);
    await screen.findByText("reply to c1");

    const thread = screen.getByText("body c1").closest("li");
    expect(within(thread).getByText("reply to c1")).toBeTruthy();
    expect(within(screen.getByText("body c2").closest("li")).queryByText("reply to c1")).toBeNull();
  });

  it("keeps a comment that arrives live while the list is loading", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(JSON.stringify({ items: [comment("c1")], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { connect, live } = fakeConnect();
    render(
      <CommentsPanel token="t0k" user={ME} documentId={DOC} versionId={VER} connect={connect} />,
    );

    act(() => live.handlers.onEvent("comment:created", comment("c9", { body: "arrived early" })));
    await act(async () => {
      release();
      await gate;
    });

    expect(await screen.findByText("body c1")).toBeTruthy();
    expect(screen.getByText("arrived early")).toBeTruthy();
  });

  it("ignores an older list that answers after a newer one", async () => {
    const answers = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            answers.push((items) =>
              resolve(
                new Response(JSON.stringify({ items, nextCursor: null }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              ),
            );
          }),
      ),
    );
    const { connect, live } = fakeConnect();
    render(
      <CommentsPanel token="t0k" user={ME} documentId={DOC} versionId={VER} connect={connect} />,
    );
    act(() => {
      live.handlers.onJoined();
    });
    await waitFor(() => expect(answers).toHaveLength(2));

    answers[1]([comment("c1"), comment("c2")]);
    await screen.findByText("body c2");
    answers[0]([comment("c1")]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(screen.getByText("body c2")).toBeTruthy();
  });

  it("sends a 403 on resolve or delete as a neutral message, not a role claim", async () => {
    const state = { comments: [comment("c2", { authorId: ME.id })] };
    const fetchMock = vi.fn(async (url, init = {}) =>
      init.method === "DELETE"
        ? new Response(JSON.stringify({ error: "Forbidden", code: "FORBIDDEN" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({ items: state.comments, nextCursor: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { connect } = fakeConnect();
    render(
      <CommentsPanel token="t0k" user={ME} documentId={DOC} versionId={VER} connect={connect} />,
    );
    await screen.findByText("body c2");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/not allowed/i);
  });
});
