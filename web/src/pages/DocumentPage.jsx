// Document view (D28): one version's comments, live; download and the version list wait for #116.
import CommentsPanel from "../comments/CommentsPanel.jsx";

const PENDING = "after 24 Nov";

export default function DocumentPage({ token, user, documentId, versionId, connect }) {
  return (
    <>
      <section className="card wide">
        <p>
          <a href="#/">Back to documents</a>
        </p>
        <h2>Document</h2>
        <button type="button" disabled title={`${PENDING}: needs the versions routes (#116)`}>
          Download
        </button>
        <h3>Versions</h3>
        <p className="pending">The version list appears here {PENDING} (#116).</p>
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
