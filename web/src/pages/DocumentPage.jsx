// Document view, shown disabled: versions (#116), comments (#135) and live comments (#136) are not on main.
const PENDING = "after 24 Nov";

export default function DocumentPage() {
  return (
    <section className="card">
      <h2>Document</h2>
      <button type="button" disabled title={`${PENDING}: needs the versions routes (#116)`}>
        Download
      </button>
      <h3>Versions</h3>
      <p className="pending">The version list appears here {PENDING} (#116).</p>
      <h3>Comments</h3>
      <p className="pending">
        Comments, and new ones arriving live, appear here {PENDING} (#135, #136).
      </p>
      <form onSubmit={(event) => event.preventDefault()}>
        <label className="field">
          <span>Comment</span>
          <textarea name="body" rows={3} disabled />
        </label>
        <button type="submit" disabled title={`${PENDING}: needs the comments routes (#135)`}>
          Add comment
        </button>
      </form>
    </section>
  );
}
