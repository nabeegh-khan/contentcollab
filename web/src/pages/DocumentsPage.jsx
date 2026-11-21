// Documents page: list and upload shown disabled until #116; sharing works now through #114.
import ShareForm from "../shares/ShareForm.jsx";

const PENDING = "after 24 Nov: needs the documents routes (#116)";

export default function DocumentsPage({ token }) {
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
      <ShareForm token={token} />
    </>
  );
}
