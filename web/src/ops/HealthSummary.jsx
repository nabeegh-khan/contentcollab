// The first thing on the operations page (D35): four lines that say, in words, whether the system is healthy.
// Every line is a title, a word (OK, Check or Not measured) with a shape, and a sentence computed from the snapshot.
import { healthLines } from "./health.js";

export default function HealthSummary({ data }) {
  return (
    <section className="ops-health" aria-labelledby="ops-health-summary">
      <h2 id="ops-health-summary">Health summary</h2>
      <ul>
        {healthLines(data).map((line) => (
          <li key={line.key} className={`ops-health-${line.state}`}>
            <strong>{line.title}</strong>
            <span className="ops-health-word">
              <span aria-hidden="true">{line.shape}</span> {line.word}
            </span>
            <span>{line.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
