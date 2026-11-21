// Documents page: list and upload stay disabled until #116; a version opens by its ids (D28).
import { useState } from "react";
import { documentHash, isId } from "../route.js";
import ShareForm from "../shares/ShareForm.jsx";

const PENDING = "after 24 Nov: needs the documents routes (#116)";

export default function DocumentsPage({ token }) {
  const [documentId, setDocumentId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [problem, setProblem] = useState(null);

  function open(event) {
    event.preventDefault();
    const doc = documentId.trim();
    const ver = versionId.trim();
    if (!isId(doc) || !isId(ver)) {
      setProblem("Both ids must be ids, like 123e4567-e89b-42d3-a456-426614174000.");
      return;
    }
    setProblem(null);
    window.location.hash = documentHash(doc, ver);
  }

  return (
    <>
      <section className="card">
        <h2>Documents</h2>
        <form className="upload" onSubmit={(event) => event.preventDefault()}>
          <label className="field">
            <span>File</span>
            <input type="file" name="file" disabled />
          </label>
          <label className="field">
            <span>Title</span>
            <input type="text" name="title" disabled />
          </label>
          <button type="submit" disabled title={PENDING}>
            Upload
          </button>
        </form>
        <p className="pending">Your documents appear here {PENDING}.</p>
        <button type="button" disabled title={PENDING}>
          Load more
        </button>
      </section>
      <section className="card">
        <h3>Open a version</h3>
        <p>Until the list is live, open the comments of a version by its ids.</p>
        <form onSubmit={open}>
          <label className="field">
            <span>Document id</span>
            <input type="text" value={documentId} onChange={(e) => setDocumentId(e.target.value)} />
          </label>
          <label className="field">
            <span>Version id</span>
            <input type="text" value={versionId} onChange={(e) => setVersionId(e.target.value)} />
          </label>
          {problem && <p role="alert">{problem}</p>}
          <button type="submit">Open version</button>
        </form>
      </section>
      <ShareForm token={token} />
    </>
  );
}
