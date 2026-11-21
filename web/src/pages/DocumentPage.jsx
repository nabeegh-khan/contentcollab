// Document view (D28): the document's versions (list, upload, download) and one version's comments, live.
import CommentsPanel from "../comments/CommentsPanel.jsx";
import VersionsPanel from "../versions/VersionsPanel.jsx";

export default function DocumentPage({ token, user, documentId, versionId, connect }) {
  return (
    <>
      <section className="card wide">
        <p>
          <a href="#/">Back to documents</a>
        </p>
        <h2>Document</h2>
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
