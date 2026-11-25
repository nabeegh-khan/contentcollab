// Where the toasts appear, and where they must not (D40, #192): uploads, comments by others, shares, the live connection.
// Never for a routine read: a list loading, a reload, paging.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CommentsPanel from "../comments/CommentsPanel.jsx";
import DocumentsPage from "../pages/DocumentsPage.jsx";
import ShareForm from "../shares/ShareForm.jsx";
import VersionsPanel from "../versions/VersionsPanel.jsx";
import { ToastProvider } from "./ToastProvider.jsx";

const ME = { id: "aaaaaaaa-1111-4111-8111-111111111111", displayName: "Ann" };
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222";
const DOC = "11111111-1111-4111-8111-111111111111";
const VER = "22222222-2222-4222-8222-222222222222";

const pdf = (name) => new File(["%PDF-1.4"], name, { type: "application/pdf" });
const carrying = (files) => ({ dataTransfer: { files, types: ["Files"] } });
const region = () => screen.getByRole("region", { name: "Notifications" });
const toasts = () => within(region()).queryAllByRole("listitem");
const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function withToasts(ui) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe("toasts for uploads on the documents page", () => {
  function server(refuse = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        if ((init.method ?? "GET") !== "POST") return reply(200, { items: [], nextCursor: null });
        const file = init.body.get("file");
        if (refuse[file.name]) return reply(refuse[file.name], { error: "x", code: "X" });
        return reply(201, { id: file.name, title: file.name, role: "owner" });
      }),
    );
  }

  it("shows no toast while the list loads or when it is empty", async () => {
    server();
    withToasts(<DocumentsPage token="t0k" />);
    await screen.findByText(/no documents yet/i);
    expect(toasts()).toEqual([]);
  });

  it("shows one toast for a drop of three files, not one per file", async () => {
    server();
    withToasts(<DocumentsPage token="t0k" />);
    await screen.findByText(/no documents yet/i);

    fireEvent.drop(
      screen.getByRole("group", { name: /drop files/i }),
      carrying([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]),
    );

    await waitFor(() => expect(toasts().length).toBe(1));
    expect(toasts()[0].textContent).toContain("3 files uploaded.");
    expect(toasts()[0].dataset.kind).toBe("success");
  });

  it("says how many went and how many failed, as an error", async () => {
    server({ "b.pdf": 413 });
    withToasts(<DocumentsPage token="t0k" />);
    await screen.findByText(/no documents yet/i);

    fireEvent.drop(
      screen.getByRole("group", { name: /drop files/i }),
      carrying([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]),
    );

    await waitFor(() => expect(toasts().length).toBe(1));
    expect(toasts()[0].textContent).toContain("2 uploaded, 1 failed.");
    expect(toasts()[0].dataset.kind).toBe("error");
  });

  it("names the file and the reason when the one file is refused in the browser", async () => {
    server();
    withToasts(<DocumentsPage token="t0k" />);
    await screen.findByText(/no documents yet/i);

    fireEvent.drop(
      screen.getByRole("group", { name: /drop files/i }),
      carrying([new File(["MZ"], "setup.exe", { type: "application/octet-stream" })]),
    );

    await waitFor(() => expect(toasts().length).toBe(1));
    expect(toasts()[0].textContent).toMatch(/setup\.exe was not uploaded: .*not allowed/);
  });

  it("shows one toast for a file from the picker", async () => {
    server();
    withToasts(<DocumentsPage token="t0k" />);
    await screen.findByText(/no documents yet/i);

    fireEvent.change(screen.getByLabelText("File"), { target: { files: [pdf("plan.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(toasts()[0]?.textContent).toContain("plan.pdf uploaded."));
  });
});

describe("toasts for new versions", () => {
  it("shows one toast when a dropped file became a version, none for loading the list", async () => {
    let count = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        if ((init.method ?? "GET") === "GET") {
          return reply(200, {
            items: [{ id: "v1", number: 1, filename: "first.pdf", size: 8, documentId: DOC }],
          });
        }
        count += 1;
        return reply(201, { id: `v${count}`, number: count, filename: "n.pdf", size: 8 });
      }),
    );
    withToasts(<VersionsPanel token="t0k" documentId={DOC} versionId={VER} />);
    await screen.findByText(/Version 1: first.pdf/);
    expect(toasts()).toEqual([]);

    fireEvent.drop(screen.getByRole("group", { name: /drop files/i }), carrying([pdf("n.pdf")]));

    await waitFor(() => expect(toasts()[0]?.textContent).toContain("n.pdf uploaded."));
  });
});

describe("toasts for comments and the live connection", () => {
  function mount() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { items: [], nextCursor: null })),
    );
    const live = { handlers: null };
    const connect = vi.fn((options) => {
      live.handlers = options;
      return { close: vi.fn() };
    });
    withToasts(
      <CommentsPanel token="t0k" user={ME} documentId={DOC} versionId={VER} connect={connect} />,
    );
    return live;
  }
  const created = (authorId, extra = {}) => ({
    id: "c1",
    versionId: VER,
    authorId,
    parentId: null,
    body: "hello",
    anchor: null,
    resolved: false,
    createdAt: "2026-11-25T15:00:00.000Z",
    updatedAt: "2026-11-25T15:00:00.000Z",
    ...extra,
  });

  it("shows a toast when someone else's comment arrives live, with their name", async () => {
    const live = mount();
    await screen.findByText("No comments yet.");

    act(() =>
      live.handlers.onEvent("comment:created", created(OTHER, { authorDisplayName: "Bo" })),
    );

    expect(toasts().length).toBe(1);
    expect(toasts()[0].textContent).toContain("Bo commented.");
  });

  it("shows no toast for the user's own comment, an edit, a delete, or the list loading", async () => {
    const live = mount();
    await screen.findByText("No comments yet.");

    act(() => live.handlers.onEvent("comment:created", created(ME.id)));
    act(() => live.handlers.onEvent("comment:updated", created(OTHER, { resolved: true })));
    act(() => live.handlers.onEvent("comment:deleted", { id: "c1" }));
    await act(async () => live.handlers.onJoined());

    expect(toasts()).toEqual([]);
  });

  it("shows no toast for the first connection, one when it is lost, one when it is back", async () => {
    const live = mount();
    await screen.findByText("No comments yet.");

    act(() => live.handlers.onState("connecting"));
    act(() => live.handlers.onState("live"));
    expect(toasts()).toEqual([]);

    act(() => live.handlers.onState("reconnecting"));
    expect(toasts().length).toBe(1);
    expect(toasts()[0].textContent).toMatch(/lost/i);

    act(() => live.handlers.onState("live"));
    expect(toasts().length).toBe(2);
    expect(toasts()[1].textContent).toMatch(/back/i);
  });

  it("shows one toast, not two, when the connection drops from reconnecting to offline", async () => {
    const live = mount();
    await screen.findByText("No comments yet.");
    act(() => live.handlers.onState("live"));

    act(() => live.handlers.onState("reconnecting"));
    act(() => live.handlers.onState("reconnecting"));
    act(() => live.handlers.onState("offline"));

    expect(toasts().length).toBe(1);
  });

  it("shows no toast when live updates were never available (the join was refused)", async () => {
    const live = mount();
    await screen.findByText("No comments yet.");

    act(() => live.handlers.onState("connecting"));
    act(() => live.handlers.onState("error"));
    act(() => live.handlers.onState("reconnecting"));

    expect(toasts()).toEqual([]);
  });
});

describe("toasts for shares", () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText("Id of the document to share"), {
      target: { value: DOC },
    });
    fireEvent.change(screen.getByLabelText("Email of the user"), { target: { value: "bo@x.co" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
  };

  it("shows a toast when a share was sent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(201, { id: "s1" })));
    withToasts(<ShareForm token="t0k" />);

    fill();

    await waitFor(() =>
      expect(toasts()[0]?.textContent).toContain("Shared with bo@x.co as viewer."),
    );
    expect(toasts()[0].dataset.kind).toBe("success");
  });

  it("keeps a refusal as the inline alert only, so it is not announced twice, and no toast for an empty form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(409, { error: "x", code: "X" })));
    withToasts(<ShareForm token="t0k" />);

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(toasts()).toEqual([]);

    fill();
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has a share/);
    expect(toasts()).toEqual([]);
  });
});
