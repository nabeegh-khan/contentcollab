// One line per file of the last batch: waiting, uploading (an indeterminate bar), the result, or the reason it failed (D40).
// Not a live region: the toast announces the batch, and these lines are there to read.
const WAITING = "Waiting";

function State({ item }) {
  if (item.status === "waiting") return <span>{WAITING}</span>;
  if (item.status === "uploading") {
    return (
      <span>
        Uploading <progress aria-label={`Uploading ${item.name}`} />
      </span>
    );
  }
  return (
    <span className={item.status === "failed" ? "upload-failed" : undefined}>{item.message}</span>
  );
}

export default function UploadList({ items }) {
  if (items.length === 0) return null;
  return (
    <ul className="uploads" aria-label="Uploads">
      {items.map((item) => (
        <li key={item.id} data-status={item.status}>
          <span className="upload-name">{item.name}</span> <State item={item} />
        </li>
      ))}
    </ul>
  );
}
