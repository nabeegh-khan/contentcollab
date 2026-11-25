// Documents page: the signed-in user's documents (list, Load more, upload) from the #116 routes; each opens its latest version (D28).
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import { createDocument, listDocuments } from "../api/documents.js";
import { formatClock } from "../comments/time.js";
import { documentHash } from "../route.js";
import ShareForm from "../shares/ShareForm.jsx";
import { useToasts } from "../toasts/ToastProvider.jsx";
import DropZone from "../uploads/DropZone.jsx";
import UploadList from "../uploads/UploadList.jsx";
import { summarizeBatch } from "../uploads/summary.js";
import { useUploads } from "../uploads/useUploads.js";

// The extensions api/src/lib/parseUpload.ts accepts
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx,.txt,.md";

// New documents upload three at a time; the order of the list does not matter for them (D40)
const DOCUMENT_UPLOADS_AT_ONCE = 3;

// A readable reason for a refused upload; a validation refusal (a long title) says what the API says
function uploadReason(error) {
  if (error instanceof ApiError) {
    if (error.status === 413) return "That file is too large: the limit is 50 MiB.";
    const detail = error.details[0]?.message;
    if (error.status === 400 && detail) return `The upload was refused: ${detail}.`;
    if (error.status === 400)
      return "That file type is not allowed. Allowed: .pdf, .png, .jpg, .jpeg, .docx, .xlsx, .pptx, .txt, .md.";
  }
  return "Could not upload. Try again.";
}

function DocumentRow({ document: doc, onShare }) {
  return (
    <li>
      <span>{doc.title}</span> <small>Role: {doc.role}</small>{" "}
      <small>Updated {formatClock(doc.updatedAt)}</small>{" "}
      {doc.currentVersionId ? (
        <a href={documentHash(doc.id, doc.currentVersionId)} aria-label={`Open ${doc.title}`}>
          Open
        </a>
      ) : (
        <small>No version yet</small>
      )}
      {doc.role === "owner" && (
        <>
          {" "}
          <button type="button" aria-label={`Share ${doc.title}`} onClick={() => onShare(doc.id)}>
            Share
          </button>
        </>
      )}
    </li>
  );
}

export default function DocumentsPage({ token }) {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [share, setShare] = useState({ id: "", count: 0 });
  const [loadState, setLoadState] = useState("loading");
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState(null);
  const uploads = useUploads();
  const { notify } = useToasts();
  const [moreBusy, setMoreBusy] = useState(false);
  const fileInput = useRef(null);
  const loadingMore = useRef(false);

  const loadFirstPage = useCallback(async () => {
    try {
      const page = await listDocuments(token);
      setItems(page.items);
      setNextCursor(page.nextCursor ?? null);
      setLoadState("ready");
    } catch {
      // A reload that fails keeps what is already shown; only a first load with nothing shows the error
      setLoadState((state) => (state === "ready" ? "ready" : "error"));
    }
  }, [token]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  async function loadMore() {
    if (loadingMore.current) return;
    loadingMore.current = true;
    setMoreBusy(true);
    setProblem(null);
    try {
      const page = await listDocuments(token, { cursor: nextCursor });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor ?? null);
    } catch {
      setProblem("Could not load more documents. Try again.");
    } finally {
      loadingMore.current = false;
      setMoreBusy(false);
    }
  }

  // One request per file; the title applies only when a single file is uploaded, several use their file names
  async function uploadFiles(files) {
    const single = files.length === 1;
    const done = await uploads.start(files, {
      concurrency: DOCUMENT_UPLOADS_AT_ONCE,
      send: async (file) => {
        const created = await createDocument(token, file, single ? title : "");
        return `Uploaded "${created.title}".`;
      },
      reasonOf: uploadReason,
    });
    if (!done) return;
    notify(summarizeBatch(done));
    if (done.some((item) => item.status === "done")) {
      if (single) setTitle("");
      await loadFirstPage();
    }
  }

  async function upload(event) {
    event.preventDefault();
    const files = Array.from(fileInput.current?.files ?? []);
    if (files.length === 0) {
      setProblem("Choose a file first.");
      return;
    }
    setProblem(null);
    if (fileInput.current) fileInput.current.value = "";
    await uploadFiles(files);
  }

  function drop(files) {
    setProblem(null);
    return uploadFiles(files);
  }

  return (
    <>
      <section className="card wide">
        <h2>Documents</h2>
        <form className="upload" onSubmit={upload}>
          <DropZone onFiles={drop} disabled={uploads.busy}>
            <label className="field">
              <span>File</span>
              <input type="file" name="file" accept={ACCEPT} multiple ref={fileInput} />
            </label>
          </DropZone>
          <label className="field">
            <span>Title</span>
            <input
              type="text"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <p className="hint">
            The title is used when you upload one file; several files use their file names.
          </p>
          {problem && <p role="alert">{problem}</p>}
          <button type="submit" className="primary" disabled={uploads.busy}>
            Upload
          </button>
        </form>
        <UploadList items={uploads.items} />
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
              <DocumentRow
                key={doc.id}
                document={doc}
                onShare={(id) => setShare((last) => ({ id, count: last.count + 1 }))}
              />
            ))}
          </ul>
        )}
        {nextCursor && (
          <button type="button" disabled={moreBusy} onClick={loadMore}>
            Load more
          </button>
        )}
      </section>
      <ShareForm token={token} documentId={share.id} choiceCount={share.count} />
    </>
  );
}
