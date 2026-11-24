// The cards of the operations page (D31). Every value is rendered as text (SEC-7); every state is a word plus a shape.
import {
  ageText,
  cpuNowLine,
  eventSentence,
  latencyText,
  rangeLine,
  statusView,
} from "./format.js";
import { alertStatus, backupText } from "./health.js";

const MS_ROUND = 10;
// Newest request lines shown on the Latest requests card (the API sends up to 20)
const REQUESTS_SHOWN = 10;
// Newest events shown: the list is a short strip beside Containers, not a scroll box that traps the wheel
const EVENTS_SHOWN = 8;

// A card with a heading as its name; a section that failed says so and why
function Card({ title, problem, span, children }) {
  const id = `ops-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section className={span ? `ops-card ops-span-${span}` : "ops-card"} aria-labelledby={id}>
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
  // One table per node: the services that run there, so the audience sees what shares a machine
  const nodes = [...new Set((rows ?? []).map((c) => c.node ?? "no node yet"))].sort();
  return (
    <Card
      title="Containers"
      span={4}
      problem={rows ? null : (problemOf(data, "containers") ?? "no data")}
    >
      {nodes.map((node) => (
        <table key={node} aria-label={`Pods on ${node}`}>
          <caption>Node {node}</caption>
          <thead>
            <tr>
              <th>State</th>
              <th>Part</th>
              <th>Pod</th>
              <th>Restarts</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((c) => (c.node ?? "no node yet") === node)
              .map((c) => {
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
                    <td>{c.restarts}</td>
                    <td>{ageText(c.ageSeconds)}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      ))}
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
            API copies: {hpa.currentReplicas} of {hpa.desiredReplicas}
          </p>
          <p>{rangeLine(hpa)}</p>
          <p>{cpuNowLine(hpa)}</p>
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

// "not available" and, when the API named one, why
const unavailable = (data, key) => {
  const reason = problemOf(data, key);
  return reason ? `not available (${reason})` : "not available";
};

export function StorageCard({ data }) {
  const { claim, volume, backup, diskUsedPercent, documents, versions, comments } =
    data.storage ?? {};
  const failed = problemOf(data, "claim") && problemOf(data, "counts");
  const measured = diskUsedPercent !== null && diskUsedPercent !== undefined;
  return (
    <Card title="Storage" problem={failed ? (problemOf(data, "claim") ?? "unavailable") : null}>
      <p>
        {claim
          ? `Database disk: ${claim.capacity ?? "size unknown"}, ${claim.phase}${claim.phase === "Bound" ? " (attached)" : ""}`
          : "Database disk: not available"}
      </p>
      {claim && <p>{`Claim: ${claim.name}, storage class ${claim.storageClass ?? "unknown"}`}</p>}
      <p>
        {volume
          ? `Reclaim policy: ${volume.reclaimPolicy}${volume.reclaimPolicy === "Retain" ? " (the data is kept if the claim is deleted)" : ""}`
          : `Reclaim policy: ${unavailable(data, "volume")}`}
      </p>
      <p>{`Disk used: ${measured ? `${Math.round(diskUsedPercent)}%` : "not measured"}`}</p>
      <p>
        {backup
          ? `Last nightly backup: ${backupText(backup, Date.parse(data.generatedAt))}`
          : `Last nightly backup: ${unavailable(data, "backup")}`}
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
      <p>
        {comments === null || comments === undefined
          ? "Comments stored: not available"
          : `Comments stored: ${comments}`}
      </p>
    </Card>
  );
}

export function QueueCard({ data }) {
  const depth = data.queue?.depth;
  const hasDepth = depth !== null && depth !== undefined;
  return (
    <Card title="Job queue" problem={hasDepth ? null : (problemOf(data, "queue") ?? "no data")}>
      <p>Jobs waiting: {depth}</p>
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
  const older = Math.max(0, events.length - EVENTS_SHOWN);
  return (
    <Card title="Recent events" span={2} problem={problemOf(data, "events")}>
      {events.length === 0 ? (
        <p>No events in the last hour</p>
      ) : (
        <>
          <ul aria-label="Recent events">
            {events.slice(0, EVENTS_SHOWN).map((e, i) => (
              // the lists are replaced whole on each refresh, so the position is a safe key
              <li key={`${i}-${e.at}`}>
                <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time>{" "}
                {eventSentence(e)}
              </li>
            ))}
          </ul>
          {older > 0 && <p>{older} older events are not shown</p>}
        </>
      )}
    </Card>
  );
}

// The thresholds are the ones of the DigitalOcean alert policies (scripts/alerts.sh); the values are Prometheus's,
// and so is the status: DigitalOcean only sends the email (D35)
export function AlertsCard({ data }) {
  const alerts = data.alerts;
  return (
    <Card
      title="Alerts"
      span={3}
      problem={alerts ? null : (problemOf(data, "alerts") ?? "no data")}
    >
      {alerts && (
        <>
          <table aria-label="Alert thresholds and current values">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Alert above</th>
                <th>Now</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {alerts.rows.map((row) => {
                const status = alertStatus(row.valuePercent, row.thresholdPercent);
                const measured = row.valuePercent !== null && row.valuePercent !== undefined;
                return (
                  <tr key={row.metric}>
                    <td>{row.metric}</td>
                    <td>{row.thresholdPercent}%</td>
                    <td>{measured ? `${Math.round(row.valuePercent)}%` : "not measured"}</td>
                    <td>
                      <span aria-hidden="true">{status.shape}</span> {status.word}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            Thresholds match our DigitalOcean alert policies; DigitalOcean sends the alert email.
          </p>
          <p>
            <small>
              Current values: Prometheus, the busiest node; DigitalOcean reads the droplet, so its
              figures differ a little. Disk is not measured by Prometheus here.
            </small>
          </p>
        </>
      )}
    </Card>
  );
}

// No rows and no failure: nothing to show, so no empty card on the demo page
export function LogsCard({ data }) {
  const logs = data.logs ?? { lines: [], hidden: 0 };
  const problem = problemOf(data, "logs");
  if (!problem && logs.lines.length === 0) return null;
  return (
    <Card title="Latest requests" span={6} problem={problem}>
      <ul className="ops-capped">
        {/* The API sends the oldest first; the newest ten, newest on top, are what a room can read */}
        {logs.lines
          .slice(-REQUESTS_SHOWN)
          .reverse()
          .map((l, i) => (
            <li key={`${i}-${l.at}`}>
              <time dateTime={l.at}>{new Date(l.at).toLocaleTimeString()}</time>
              {` ${l.method ?? "?"} ${l.route ?? "?"} ${l.status ?? "?"} ${Math.round(l.durationMs ?? 0)} ms (${l.pod})`}
            </li>
          ))}
      </ul>
      {logs.hidden > 0 && <p>{logs.hidden} other log lines are not shown</p>}
    </Card>
  );
}
