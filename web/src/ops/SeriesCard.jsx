// Per-pod CPU and memory lines for the last 15 minutes, refreshed every 5 s (D31 follow-up). Own loop, so a
// slow Prometheus never holds back the rest of the page.
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import { getSeries } from "./api.js";

const REFRESH_MS = 5000;
const WIDTH = 560;
const HEIGHT = 200;
const PAD = 8;
const REFUSED = new Set([401, 403]);
// A different dash per pod, so the lines differ by more than colour
const DASHES = ["none", "8 4", "2 4", "10 3 2 3", "4 4 1 4"];

function Chart({ title, unit, rows }) {
  const points = rows.flatMap((r) => r.points);
  const times = points.map((p) => p.t);
  const values = points.map((p) => p.v);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const top = Math.max(1, ...values);
  const x = (t) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (WIDTH - 2 * PAD);
  const y = (v) => HEIGHT - PAD - (v / top) * (HEIGHT - 2 * PAD);
  return (
    <div>
      <svg
        role="img"
        aria-label={title}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="ops-chart"
        width="100%"
      >
        {rows.map((r, i) => (
          <polyline
            key={r.pod}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeDasharray={DASHES[i % DASHES.length]}
            points={r.points.map((p) => `${x(p.t)},${y(p.v)}`).join(" ")}
          />
        ))}
      </svg>
      <ul aria-label={`${title.split(",")[0]} now`}>
        {rows.map((r) => {
          const last = r.points.at(-1)?.v;
          return (
            <li key={r.pod}>
              {r.pod}: {last === undefined ? "no data" : `${Math.round(last)} ${unit}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function SeriesCard({ token }) {
  const [series, setSeries] = useState(null);
  const [reason, setReason] = useState(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = null;
    async function load() {
      try {
        const answer = await getSeries(token);
        if (!alive) return;
        if (answer && "series" in answer) {
          setSeries(answer.series);
          setReason(answer.series ? null : (answer.error ?? "unavailable"));
          setStale(false);
        } else {
          setStale(true);
        }
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && REFUSED.has(error.status)) {
          alive = false;
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

  const empty = !series || (series.cpu.length === 0 && series.memory.length === 0);
  return (
    <section className="ops-card ops-wide" aria-labelledby="ops-pod-charts">
      <h2 id="ops-pod-charts">Pod CPU and memory, last 15 minutes</h2>
      {reason && <p role="status">Not available: {reason}</p>}
      {stale && <p role="status">Last update failed; showing the previous charts.</p>}
      {series && !empty && (
        <>
          <Chart title="CPU per pod, millicores, last 15 minutes" unit="m" rows={series.cpu} />
          <Chart title="Memory per pod, MiB, last 15 minutes" unit="MiB" rows={series.memory} />
        </>
      )}
      {series && empty && <p>No pod data in the last 15 minutes</p>}
    </section>
  );
}
