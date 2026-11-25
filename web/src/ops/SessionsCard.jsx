// Open WebSocket sessions over all API replicas (D38): the total, and the split per replica. Own 5 s loop, like
// the CPU and memory charts, so a slow answer never holds back the other cards. No user is named anywhere.
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import { getSessions } from "./api.js";

const REFRESH_MS = 5000;
const REFUSED = new Set([401, 403]);

// The count as the API sends it; anything else (a proxy's HTML page with status 200) is a failed update
const isRow = (row) =>
  row !== null &&
  typeof row === "object" &&
  typeof row.replica === "string" &&
  Number.isInteger(row.sessions);
const isCounts = (value) =>
  value !== null &&
  typeof value === "object" &&
  Number.isInteger(value.total) &&
  Array.isArray(value.replicas) &&
  value.replicas.every(isRow);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function SessionsCard({ token }) {
  const [counts, setCounts] = useState(null);
  const [reason, setReason] = useState(null);
  const [stale, setStale] = useState(false);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = null;
    // A new token starts clean: an earlier refusal or failure no longer applies
    setRefused(false);
    setStale(false);
    async function load() {
      try {
        const answer = await getSessions(token);
        if (!alive) return;
        if (
          answer &&
          "sessions" in answer &&
          (answer.sessions === null || isCounts(answer.sessions))
        ) {
          setCounts(answer.sessions);
          setReason(answer.sessions ? null : (answer.error ?? "unavailable"));
          setStale(false);
        } else {
          setStale(true);
        }
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && REFUSED.has(error.status)) {
          alive = false;
          setRefused(true);
          return;
        }
        setStale(true);
      }
      if (alive) timer = setTimeout(load, REFRESH_MS);
    }
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [token]);

  return (
    <section className="ops-card ops-span-6" aria-labelledby="ops-active-sessions">
      <h2 id="ops-active-sessions">Active sessions</h2>
      {/* One region that is always in the page, so a message that appears later is announced */}
      <div role="status">
        {reason && <p>Not available: {reason}</p>}
        {stale && <p>Last update failed; showing the previous count.</p>}
        {refused && <p>No longer updating: sign in again.</p>}
        {counts?.partial && (
          <p>
            Partial count: at least one replica did not answer in time, so the total may be low.
          </p>
        )}
      </div>
      {counts && (
        <>
          <p className="ops-big" aria-live="polite">
            {`${plural(counts.total, "session", "sessions")} open across ${plural(counts.replicas.length, "API replica", "API replicas")}`}
          </p>
          <table aria-label="Sessions per API replica">
            <thead>
              <tr>
                <th scope="col">Replica</th>
                <th scope="col">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {counts.replicas.map((row, index) => (
                <tr key={`${row.replica}-${index}`}>
                  <td>{row.replica}</td>
                  <td>{row.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>This counts open connections, not people: one person with two tabs counts twice.</p>
        </>
      )}
    </section>
  );
}
