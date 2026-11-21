// The comments of one version: load, post, reply, resolve, delete, and live changes from other tabs (D28).
import { io } from "socket.io-client";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import { createComment, deleteComment, listComments, updateComment } from "../api/comments.js";
import { connectVersion } from "../realtime.js";
import CommentBody from "./CommentBody.jsx";
import CommentForm from "./CommentForm.jsx";
import { applyEvent, authorLabel, buildThreads } from "./thread.js";

const LIVE_TEXT = {
  connecting: "Connecting for live updates...",
  live: "Live: new comments appear here as they are posted.",
  reconnecting: "Reconnecting...",
  offline: "Not live: reload the page to see new comments.",
  error: "Live updates are not available for this version.",
};

const defaultConnect = (options) => connectVersion({ io, ...options });

// A readable message for a failed call; a 403 on a write means the role cannot do it
function failureMessage(error, what) {
  if (error instanceof ApiError && error.status === 403) {
    return `Your role on this document cannot ${what}.`;
  }
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

export default function CommentsPanel({
  token,
  user,
  documentId,
  versionId,
  connect = defaultConnect,
}) {
  const [comments, setComments] = useState([]);
  const [loadState, setLoadState] = useState("loading");
  const [liveState, setLiveState] = useState("connecting");
  const [mentioned, setMentioned] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [actionError, setActionError] = useState(null);

  const reload = useCallback(async () => {
    try {
      setComments(await listComments(token, documentId, versionId));
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [token, documentId, versionId]);

  useEffect(() => {
    reload();
    const live = connect({
      token,
      versionId,
      onEvent: (event, payload) => setComments((list) => applyEvent(list, event, payload)),
      onMention: () => setMentioned(true),
      onJoined: reload,
      onState: setLiveState,
    });
    return () => live.close();
  }, [token, versionId, connect, reload]);

  async function post(body, parentId) {
    try {
      const created = await createComment(token, documentId, versionId, { body, parentId });
      setComments((list) => applyEvent(list, "comment:created", created));
      setReplyTo(null);
    } catch (error) {
      throw new Error(failureMessage(error, "comment"));
    }
  }

  async function run(action, what) {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(failureMessage(error, what));
    }
  }

  const toggleResolved = (root) =>
    run(async () => {
      const updated = await updateComment(token, documentId, root.id, { resolved: !root.resolved });
      setComments((list) => applyEvent(list, "comment:updated", updated));
    }, "resolve this thread");

  const remove = (comment) =>
    run(async () => {
      await deleteComment(token, documentId, comment.id);
      setComments((list) => applyEvent(list, "comment:deleted", { id: comment.id }));
    }, "delete this comment");

  function renderComment(comment, root) {
    return (
      <div className="comment">
        <p className="comment-meta">
          <span>{authorLabel(comment.authorId, user.id)}</span>{" "}
          <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
          {comment === root && comment.resolved && <span className="badge">Resolved</span>}
        </p>
        <CommentBody body={comment.body} />
        <p className="comment-actions">
          {comment === root && replyTo !== comment.id && (
            <button type="button" onClick={() => setReplyTo(comment.id)}>
              Reply
            </button>
          )}
          {comment === root && (
            <button type="button" onClick={() => toggleResolved(comment)}>
              {comment.resolved ? "Reopen" : "Resolve"}
            </button>
          )}
          {comment.authorId === user.id && (
            <button type="button" onClick={() => remove(comment)}>
              Delete
            </button>
          )}
        </p>
      </div>
    );
  }

  const threads = buildThreads(comments);

  return (
    <section className="card comments">
      <h3>Comments</h3>
      <p role="status" className={`live live-${liveState}`}>
        {LIVE_TEXT[liveState]}
      </p>
      {mentioned && (
        <p className="notice">
          Someone mentioned you in a comment.{" "}
          <button type="button" onClick={() => setMentioned(false)}>
            Dismiss
          </button>
        </p>
      )}
      {loadState === "error" && (
        <p role="alert">Could not load the comments. Check your access and reload.</p>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {loadState === "ready" && threads.length === 0 && <p>No comments yet.</p>}
      <ul className="threads">
        {threads.map(({ root, replies }) => (
          <li key={root.id} className="thread">
            {renderComment(root, root)}
            {replies.length > 0 && (
              <ul className="replies">
                {replies.map((reply) => (
                  <li key={reply.id}>{renderComment(reply, root)}</li>
                ))}
              </ul>
            )}
            {replyTo === root.id && (
              <CommentForm
                label="Reply"
                submitLabel="Send reply"
                onSubmit={(body) => post(body, root.id)}
                onCancel={() => setReplyTo(null)}
              />
            )}
          </li>
        ))}
      </ul>
      <CommentForm label="Comment" submitLabel="Add comment" onSubmit={(body) => post(body)} />
    </section>
  );
}
