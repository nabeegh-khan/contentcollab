// Documents page: the signed-in user's documents (list, Load more, upload) from the #116 routes; each opens its latest version (D28).
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import { createDocument, listDocuments } from "../api/documents.js";
import { formatClock } from "../comments/time.js";
import { documentHash } from "../route.js";

// A readable reason for a refused upload
function uploadReason(error) {
  if (error instanceof ApiError) {
    if (error.status === 413) return "That file is too large: the limit is 50 MiB.";
    if (error.status === 400)
      return "That file type is not allowed (PDF, images, Office files, text).";
    if (error.status === 429) return "Too many uploads in a minute. Wait a moment and try again.";
  }
  return "Could not upload. Try again.";
}

function DocumentRow({ document: doc }) {
  return (
    <li>
      <span>{doc.title}</span> <small>Role: {doc.role}</small>{" "}
      <small>Updated {formatClock(doc.updatedAt)}</small>{" "}
      <a href={documentHash(doc.id, doc.currentVersionId)} aria-label={`Open ${doc.title}`}>
        Open
      </a>
    </li>
  );
}

export default function DocumentsPage({ token }) {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadState, setLoadState] = useState("loading");
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);

  const loadFirstPage = useCallback(async () => {
    try {
      const page = await listDocuments(token);
      setItems(page.items);
      setNextCursor(page.nextCursor ?? null);
      setLoadState("ready");
    } catch {
      setItems([]);
      setNextCursor(null);
      setLoadState("error");
    }
  }, [token]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  async function loadMore() {
    setProblem(null);
    try {
      const page = await listDocuments(token, { cursor: nextCursor });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor ?? null);
    } catch {
      setProblem("Could not load more documents. Try again.");
    }
  }

  async function upload(event) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    setMessage(null);
    if (!file) {
      setProblem("Choose a file first.");
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const created = await createDocument(token, file, title);
      setMessage(`Uploaded "${created.title}".`);
      setTitle("");
      if (fileInput.current) fileInput.current.value = "";
      await loadFirstPage();
    } catch (error) {
      setProblem(uploadReason(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card wide">
      <h2>Documents</h2>
      <form className="upload" onSubmit={upload}>
        <label className="field">
          <span>File</span>
          <input type="file" name="file" ref={fileInput} />
        </label>
        <label className="field">
          <span>Title</span>
          <input
            type="text"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {problem && <p role="alert">{problem}</p>}
        {message && <p role="status">{message}</p>}
        <button type="submit" className="primary" disabled={busy}>
          Upload
        </button>
      </form>
      {loadState === "loading" && <p>Loading your documents...</p>}
      {loadState === "error" && (
        <p role="alert">Could not load your documents. Check your connection and reload.</p>
      )}
      {loadState === "ready" && items.length === 0 && (
        <p>You have no documents yet. Upload one above.</p>
      )}
      {items.length > 0 && (
        <ul className="documents">
          {items.map((doc) => (
            <DocumentRow key={doc.id} document={doc} />
          ))}
        </ul>
      )}
      {nextCursor && (
        <button type="button" onClick={loadMore}>
          Load more
        </button>
      )}
    </section>
  );
}
