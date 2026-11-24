// Document view (D28): the document's versions (list, upload, download) and one version's comments, live.
import { useEffect, useState } from "react";
import { getDocument } from "../api/documents.js";
import CommentsPanel from "../comments/CommentsPanel.jsx";
import VersionsPanel from "../versions/VersionsPanel.jsx";

// The heading is the document's title once it is read; "Document" while it loads or when it cannot be read
// (a heading is not worth an error banner). The title is text, never markup (SEC-7).
export default function DocumentPage({ token, user, documentId, versionId, connect }) {
  const [title, setTitle] = useState(null);
  useEffect(() => {
    let alive = true;
    setTitle(null);
    getDocument(token, documentId)
      .then((doc) => {
        if (alive && typeof doc?.title === "string" && doc.title.trim()) setTitle(doc.title);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token, documentId]);

  return (
    <>
      <section className="card wide">
        <p>
          <a href="#/">Back to documents</a>
        </p>
        <h2>{title ?? "Document"}</h2>
        <VersionsPanel token={token} documentId={documentId} versionId={versionId} />
      </section>
      <CommentsPanel
        token={token}
        user={user}
        documentId={documentId}
        versionId={versionId}
        connect={connect}
      />
    </>
  );
}
