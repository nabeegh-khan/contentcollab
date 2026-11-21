// The cards of the operations page (D31). Every value is rendered as text (SEC-7); every state is a word plus a shape.
import { ageText, cpuLine, eventSentence, latencyText, statusView } from "./format.js";

const MS_ROUND = 10;

// A card with a heading as its name; a section that failed says so and why
function Card({ title, problem, children }) {
  const id = `ops-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section className="ops-card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {problem ? <p role="status">Not available: {problem}</p> : children}
    </section>
  );
}

const problemOf = (data, key) => (data.errors ?? {})[key];

function Meter({ label, percent }) {
  return (
    <div
      className="ops-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${Math.min(percent, 100)}%` }} />
    </div>
  );
}

export function ContainersCard({ data }) {
  const rows = data.containers;
  return (
    <Card title="Containers" problem={rows ? null : (problemOf(data, "containers") ?? "no data")}>
      <table aria-label="Containers">
        <thead>
          <tr>
            <th>State</th>
            <th>Part</th>
            <th>Pod</th>
            <th>Node</th>
            <th>Restarts</th>
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((c) => {
            const view = statusView(c.status);
            return (
              <tr key={c.pod}>
                <td>
                  <span aria-hidden="true">{view.shape}</span> {view.label}
                </td>
                <td>{c.component}</td>
                <td>
                  {c.pod}
                  {c.servingThisRequest && <small> (answering this page)</small>}
                </td>
                <td>{c.node ?? "none yet"}</td>
                <td>{c.restarts}</td>
                <td>{ageText(c.ageSeconds)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

export function HpaCard({ data }) {
  const hpa = data.hpa;
  return (
    <Card title="Autoscaler" problem={hpa ? null : (problemOf(data, "hpa") ?? "no data")}>
      {hpa && (
        <>
          <p className="ops-big">
            API copies running: {hpa.currentReplicas} of {hpa.desiredReplicas} (autoscaler may use{" "}
            {hpa.minReplicas} to {hpa.maxReplicas})
          </p>
          <p>{cpuLine(hpa)}</p>
        </>
      )}
    </Card>
  );
}

export function NodesCard({ data }) {
  const nodes = data.nodes;
  return (
    <Card title="Nodes" problem={nodes ? null : (problemOf(data, "nodes") ?? "no data")}>
      {(nodes ?? []).map((n) => (
        <div key={n.name} className="ops-node">
          <strong>{n.name}</strong>
          <p>CPU {n.cpuPercent}%</p>
          <Meter label={`${n.name} CPU`} percent={n.cpuPercent} />
          <p>Memory {n.memoryPercent}%</p>
          <Meter label={`${n.name} memory`} percent={n.memoryPercent} />
        </div>
      ))}
    </Card>
  );
}

export function StorageCard({ data }) {
  const { claim, documents, versions } = data.storage ?? {};
  const failed = problemOf(data, "claim") && problemOf(data, "counts");
  return (
    <Card title="Storage" problem={failed ? "unavailable" : null}>
      <p>
        {claim
          ? `Database disk: ${claim.capacity ?? "size unknown"}, ${claim.phase}${claim.phase === "Bound" ? " (attached)" : ""}`
          : "Database disk: not available"}
      </p>
      <p>
        {documents === null || documents === undefined
          ? "Documents stored: not available"
          : `Documents stored: ${documents}`}
      </p>
      <p>
        {versions === null || versions === undefined
          ? "Versions stored: not available"
          : `Versions stored: ${versions}`}
      </p>
    </Card>
  );
}

export function TrafficCard({ data }) {
  const t = data.traffic;
  return (
    <Card title="Traffic" problem={t ? null : (problemOf(data, "traffic") ?? "no data")}>
      {t && t.noTraffic && <p>No requests in the last minute</p>}
      {t && !t.noTraffic && (
        <>
          <p className="ops-big">
            Requests per second: {Math.round(t.requestsPerSecond * MS_ROUND) / MS_ROUND}
          </p>
          <p>{latencyText(t.p95Seconds)}</p>
          <p>
            Errors in the last minute: {Math.round((t.errorPercent ?? 0) * MS_ROUND) / MS_ROUND}%
          </p>
        </>
      )}
    </Card>
  );
}

export function EventsCard({ data }) {
  const events = data.events ?? [];
  return (
    <Card title="Recent events" problem={problemOf(data, "events")}>
      {events.length === 0 ? (
        <p>No events in the last hour</p>
      ) : (
        <ul aria-label="Recent events">
          {events.map((e) => (
            <li key={`${e.at}-${e.object}-${e.reason}`}>
              <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time> {eventSentence(e)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function LogsCard({ data }) {
  const logs = data.logs ?? { lines: [], hidden: 0 };
  return (
    <Card title="Latest requests" problem={problemOf(data, "logs")}>
      <ul>
        {logs.lines.map((l) => (
          <li key={`${l.at}-${l.pod}-${l.route}`}>
            {`${l.method ?? "?"} ${l.route ?? "?"} ${l.status ?? "?"} ${Math.round(l.durationMs ?? 0)} ms (${l.pod})`}
          </li>
        ))}
      </ul>
      {logs.hidden > 0 && <p>{logs.hidden} other log lines are not shown</p>}
    </Card>
  );
}
