// The serverless function card (D39): the last comparisons and whether the function or the fallback answered.
// Every value is rendered as text (SEC-7); the outcome is a word, not only a colour.
const BYTES_PER_KB = 1024;
const MS_ROUND = 10;
const TIME_START = 11;
const TIME_END = 19;

const timeText = (iso) => `${String(iso).slice(TIME_START, TIME_END)} UTC`;
const msText = (ms) =>
  typeof ms === "number" ? `${Math.round(ms * MS_ROUND) / MS_ROUND} ms` : "none";
const sizeText = (bytes) => `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;

function Summary({ invocations }) {
  const byFunction = invocations.filter((i) => i.outcome === "function").length;
  return (
    <p>
      Last {invocations.length} comparisons: {byFunction} by the function,{" "}
      {invocations.length - byFunction} by the fallback
    </p>
  );
}

function Rows({ invocations }) {
  return (
    <table aria-label="Last function invocations">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Answered by</th>
          <th scope="col">Call</th>
          <th scope="col">Function compute</th>
          <th scope="col">Input</th>
          <th scope="col">Reason</th>
        </tr>
      </thead>
      <tbody>
        {invocations.map((i) => (
          <tr key={`${i.at}-${i.ms}-${i.inputBytes}-${i.outcome}`}>
            <td>{timeText(i.at)}</td>
            <td>{i.outcome}</td>
            <td>{msText(i.ms)}</td>
            <td>{msText(i.computeMs)}</td>
            <td>{sizeText(i.inputBytes)}</td>
            <td>{i.reason ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function body(card) {
  if (!card.configured) {
    return <p>No function is configured here: the API computes every comparison itself.</p>;
  }
  if (card.invocations.length === 0) {
    return <p>No comparison has called the function yet.</p>;
  }
  return (
    <>
      <Summary invocations={card.invocations} />
      <Rows invocations={card.invocations} />
    </>
  );
}

export default function FunctionCard({ data }) {
  const card = data.functions;
  const problem = card ? null : ((data.errors ?? {}).functions ?? "no data");
  return (
    <section className="ops-card" aria-labelledby="ops-serverless-function">
      <h2 id="ops-serverless-function">Serverless function</h2>
      {problem ? <p role="status">Not available: {problem}</p> : body(card)}
    </section>
  );
}
