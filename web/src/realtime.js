// Socket.IO for one version: connect with the token, join its room on every connect, hand events to the page (D28).
// `io` is socket.io-client's factory, passed in so a test can supply a stand-in.
const COMMENT_EVENTS = ["comment:created", "comment:updated", "comment:deleted"];

export function connectVersion({ io, token, versionId, onEvent, onMention, onJoined, onState }) {
  let closed = false;
  const say = (state) => {
    if (!closed) onState(state);
  };

  const socket = io({ path: "/socket.io", transports: ["websocket"], auth: { token } });
  say("connecting");

  // The server drops a connection's rooms when it ends and `connect` fires again after every
  // reconnection, so the join lives here
  socket.on("connect", () => {
    socket.emit("join", { versionId }, (answer) => {
      if (closed) return;
      if (answer && answer.ok) {
        say("live");
        onJoined();
      } else {
        say("error");
      }
    });
  });

  socket.on("disconnect", () => say(socket.active ? "reconnecting" : "offline"));
  socket.on("connect_error", () => say(socket.active ? "reconnecting" : "offline"));

  for (const event of COMMENT_EVENTS) {
    socket.on(event, (payload) => {
      if (!closed) onEvent(event, payload);
    });
  }
  socket.on("mention", (payload) => {
    if (!closed) onMention(payload);
  });

  return {
    close() {
      closed = true;
      socket.disconnect();
    },
  };
}
