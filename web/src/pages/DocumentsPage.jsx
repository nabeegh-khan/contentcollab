// Document list and upload, shown disabled: GET and POST /documents are not on main yet (#116).
const PENDING = "after 24 Nov: needs the documents routes (#116)";

export default function DocumentsPage() {
  return (
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
  );
}
