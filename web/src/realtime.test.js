// Tests for the Socket.IO wrapper: handshake options, join on every connect, events out, state changes (D28).
import { describe, expect, it, vi } from "vitest";
import { connectVersion } from "./realtime.js";

// A stand-in for the socket.io-client socket: records emits and lets a test fire server events
function fakeSocket() {
  const handlers = new Map();
  const socket = {
    active: true,
    emit: vi.fn(),
    disconnect: vi.fn(),
    off: vi.fn(),
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return socket;
    },
    fire(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
  return socket;
}

function setup() {
  const socket = fakeSocket();
  const io = vi.fn().mockReturnValue(socket);
  const calls = { event: vi.fn(), mention: vi.fn(), joined: vi.fn(), state: vi.fn() };
  const live = connectVersion({
    io,
    token: "t0k",
    versionId: "v-1",
    onEvent: calls.event,
    onMention: calls.mention,
    onJoined: calls.joined,
    onState: calls.state,
  });
  return { socket, io, calls, live };
}

describe("connectVersion", () => {
  it("connects with the token, websocket only, on /socket.io", () => {
    const { io } = setup();
    expect(io).toHaveBeenCalledWith({
      path: "/socket.io",
      transports: ["websocket"],
      auth: { token: "t0k" },
    });
  });

  it("starts connecting and joins the version room from the connect handler", () => {
    const { socket, calls } = setup();
    expect(calls.state).toHaveBeenLastCalledWith("connecting");
    expect(socket.emit).not.toHaveBeenCalled();

    socket.fire("connect");

    expect(socket.emit).toHaveBeenCalledWith("join", { versionId: "v-1" }, expect.any(Function));
  });

  it("joins again on every reconnection, because the server drops rooms when a connection ends", () => {
    const { socket } = setup();
    socket.fire("connect");
    socket.fire("disconnect", "transport close");
    socket.fire("connect");
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  it("reports live and calls onJoined after each accepted join", () => {
    const { socket, calls } = setup();
    socket.fire("connect");
    socket.emit.mock.calls[0][2]({ ok: true });
    expect(calls.state).toHaveBeenLastCalledWith("live");
    expect(calls.joined).toHaveBeenCalledTimes(1);

    socket.fire("connect");
    socket.emit.mock.calls[1][2]({ ok: true });
    expect(calls.joined).toHaveBeenCalledTimes(2);
  });

  it("reports an error and does not call onJoined when the join is refused", () => {
    const { socket, calls } = setup();
    socket.fire("connect");
    socket.emit.mock.calls[0][2]({ ok: false, code: "NOT_FOUND" });
    expect(calls.state).toHaveBeenLastCalledWith("error");
    expect(calls.joined).not.toHaveBeenCalled();
  });

  it("passes the three comment events and their payload to onEvent", () => {
    const { socket, calls } = setup();
    socket.fire("comment:created", { id: "c1" });
    socket.fire("comment:updated", { id: "c1", resolved: true });
    socket.fire("comment:deleted", { id: "c1" });
    expect(calls.event.mock.calls).toEqual([
      ["comment:created", { id: "c1" }],
      ["comment:updated", { id: "c1", resolved: true }],
      ["comment:deleted", { id: "c1" }],
    ]);
  });

  it("passes a mention to onMention", () => {
    const { socket, calls } = setup();
    socket.fire("mention", { commentId: "c1", documentId: "d1", from: "u2" });
    expect(calls.mention).toHaveBeenCalledWith({ commentId: "c1", documentId: "d1", from: "u2" });
  });

  it("says reconnecting while the socket will retry, and offline once it will not", () => {
    const { socket, calls } = setup();
    socket.active = true;
    socket.fire("disconnect", "transport close");
    expect(calls.state).toHaveBeenLastCalledWith("reconnecting");

    socket.active = false;
    socket.fire("disconnect", "io server disconnect");
    expect(calls.state).toHaveBeenLastCalledWith("offline");
  });

  it("says offline when the server denies the connection, which is not retried", () => {
    const { socket, calls } = setup();
    socket.active = false;
    socket.fire("connect_error", new Error("UNAUTHORIZED"));
    expect(calls.state).toHaveBeenLastCalledWith("offline");
  });

  it("close() disconnects the socket", () => {
    const { socket, live } = setup();
    live.close();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does nothing for events that arrive after close()", () => {
    const { socket, calls, live } = setup();
    live.close();
    socket.fire("comment:created", { id: "late" });
    expect(calls.event).not.toHaveBeenCalled();
  });
});
