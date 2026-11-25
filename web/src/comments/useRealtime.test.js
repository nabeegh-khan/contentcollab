// Tests loading, live comment updates, mentions, version changes, and connection cleanup (D28).
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import useRealtime from "./useRealtime.js";

const DOC = "d-1";
const VER = "v-1";

function comment(id, extra = {}) {
  return {
    id,
    versionId: VER,
    authorId: "u1",
    parentId: null,
    body: `body ${id}`,
    anchor: null,
    resolved: false,
    ...extra,
  };
}

function setup(initialComments = []) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ items: initialComments, nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const live = { handlers: null, close: vi.fn() };
  const connect = vi.fn((options) => {
    live.handlers = options;
    return { close: live.close };
  });

  return { fetchMock, live, connect };
}

describe("useRealtime", () => {
  it("loads comments with the token and joins the version connection", async () => {
    const { fetchMock, live, connect } = setup([comment("c1")]);

    const { result } = renderHook(() =>
      useRealtime({ token: "t0k", documentId: DOC, versionId: VER, connect }),
    );

    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    expect(result.current.comments.map((item) => item.id)).toEqual(["c1"]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/documents/${DOC}/versions/${VER}/comments?limit=100`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer t0k" }),
      }),
    );
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ token: "t0k", versionId: VER }));

    act(() => live.handlers.onState("live"));
    expect(result.current.liveState).toBe("live");
  });

  it("applies live comment events and keeps anchored comments", async () => {
    const { live, connect } = setup([comment("c1")]);

    const { result } = renderHook(() =>
      useRealtime({ token: "t0k", documentId: DOC, versionId: VER, connect }),
    );

    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    const anchored = comment("c2", { anchor: { page: 1, x: 0.2, y: 0.3 } });

    act(() => live.handlers.onEvent("comment:created", anchored));

    expect(result.current.comments.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(result.current.comments.find((item) => item.id === "c2").anchor).toEqual(
      anchored.anchor,
    );
  });

  it("tracks mentions and forwards version:created notifications", async () => {
    const { live, connect } = setup();
    const onVersionCreated = vi.fn();

    const { result } = renderHook(() =>
      useRealtime({
        token: "t0k",
        documentId: DOC,
        versionId: VER,
        connect,
        onVersionCreated,
      }),
    );

    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    act(() => live.handlers.onMention({ commentId: "c1" }));
    expect(result.current.mentioned).toBe(true);

    act(() => live.handlers.onVersionCreated({ id: "v2" }));
    expect(onVersionCreated).toHaveBeenCalledWith({ id: "v2" });
  });

  it("clears an old mention notification when switching versions", async () => {
    const { live, connect } = setup();
    const { result, rerender } = renderHook(
      ({ versionId }) => useRealtime({ token: "t0k", documentId: DOC, versionId, connect }),
      { initialProps: { versionId: VER } },
    );

    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    act(() => live.handlers.onMention({ commentId: "c1" }));
    expect(result.current.mentioned).toBe(true);

    rerender({ versionId: "v-2" });

    await waitFor(() => expect(result.current.mentioned).toBe(false));
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("reloads after joining and closes the connection on unmount", async () => {
    const { fetchMock, live, connect } = setup();

    const { unmount } = renderHook(() =>
      useRealtime({ token: "t0k", documentId: DOC, versionId: VER, connect }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await live.handlers.onJoined();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
    expect(live.close).toHaveBeenCalledTimes(1);
  });
});
