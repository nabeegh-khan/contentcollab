// Per-pod CPU and memory lines for the last 15 minutes, refreshed every 5 s (D31 follow-up). Own loop, so a
// slow Prometheus never holds back the rest of the page.
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import { getSeries } from "./api.js";

const REFRESH_MS = 5000;
const WIDTH = 480;
const HEIGHT = 220;
const PAD_LEFT = 56; // room for the y-axis labels
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 34; // room for the x-axis label
const LABEL_SIZE = 14;
const SWATCH_WIDTH = 40;
const REFUSED = new Set([401, 403]);
// A different dash per pod, so the lines differ by more than colour
const DASHES = ["none", "8 4", "2 4", "10 3 2 3", "4 4 1 4"];

// One chart: a title line with the unit, the lines, a y axis from 0 to its maximum, an x-axis label, and a
// legend that shows each pod's line style next to its name and latest value
function Chart({ heading, label, legendLabel, unit, rows }) {
  const points = rows.flatMap((r) => r.points);
  const times = points.map((p) => p.t);
  const values = points.map((p) => p.v);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const top = Math.max(1, ...values);
  const left = PAD_LEFT;
  const right = WIDTH - PAD_RIGHT;
  const bottom = HEIGHT - PAD_BOTTOM;
  const x = (t) => left + ((t - t0) / Math.max(1, t1 - t0)) * (right - left);
  const y = (v) => bottom - (v / top) * (bottom - PAD_TOP);
  const captionId = `ops-chart-${heading.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <figure className="ops-figure" aria-labelledby={captionId}>
      <figcaption id={captionId} className="ops-figcaption">
        {heading}
      </figcaption>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="ops-chart"
        width="100%"
      >
        <line x1={left} y1={PAD_TOP} x2={left} y2={bottom} stroke="currentColor" strokeWidth="1" />
        <line x1={left} y1={bottom} x2={right} y2={bottom} stroke="currentColor" strokeWidth="1" />
        <text
          x={left - 6}
          y={PAD_TOP + LABEL_SIZE * 0.35}
          textAnchor="end"
          fontSize={LABEL_SIZE}
          fill="currentColor"
        >
          {Math.round(top)}
        </text>
        <text x={left - 6} y={bottom} textAnchor="end" fontSize={LABEL_SIZE} fill="currentColor">
          0
        </text>
        <text
          x={(left + right) / 2}
          y={HEIGHT - 8}
          textAnchor="middle"
          fontSize={LABEL_SIZE}
          fill="currentColor"
        >
          last 15 minutes
        </text>
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
      <ul aria-label={legendLabel} className="ops-legend">
        {rows.map((r, i) => {
          const last = r.points.at(-1)?.v;
          return (
            <li key={r.pod}>
              <svg
                aria-hidden="true"
                className="ops-swatch"
                width={SWATCH_WIDTH}
                height="10"
                viewBox={`0 0 ${SWATCH_WIDTH} 10`}
              >
                <line
                  x1="0"
                  y1="5"
                  x2={SWATCH_WIDTH}
                  y2="5"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeDasharray={DASHES[i % DASHES.length]}
                />
              </svg>{" "}
              {r.pod}: {last === undefined ? "no data" : `${Math.round(last)} ${unit}`}
            </li>
          );
        })}
      </ul>
    </figure>
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
    <section className="ops-card ops-span-6" aria-labelledby="ops-pod-charts">
      <h2 id="ops-pod-charts">Pod CPU and memory, last 15 minutes</h2>
      {reason && <p role="status">Not available: {reason}</p>}
      {stale && <p role="status">Last update failed; showing the previous charts.</p>}
      {series && !empty && (
        <div className="ops-charts">
          <Chart
            heading="CPU, millicores"
            label="CPU per pod, millicores, last 15 minutes"
            legendLabel="CPU per pod now"
            unit="m"
            rows={series.cpu}
          />
          <Chart
            heading="Memory, MiB"
            label="Memory per pod, MiB, last 15 minutes"
            legendLabel="Memory per pod now"
            unit="MiB"
            rows={series.memory}
          />
        </div>
      )}
      {series && empty && <p>No pod data in the last 15 minutes</p>}
    </section>
  );
}
