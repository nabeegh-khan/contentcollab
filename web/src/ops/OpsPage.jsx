// The operations page (D31): what kubectl would show, as cards that refresh every 5 s, for an operator.
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import { getOps } from "./api.js";
import {
  ContainersCard,
  EventsCard,
  HpaCard,
  LogsCard,
  NodesCard,
  StorageCard,
  TrafficCard,
} from "./cards.jsx";
import DrillCard from "./DrillCard.jsx";
import { agoText } from "./format.js";

const REFRESH_MS = 5000;
const TICK_MS = 1000;
const STALE_MS = 15000;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;

const REFUSED = {
  [FORBIDDEN]: "This page is for operators",
  [UNAUTHORIZED]: "Your session has ended. Sign out and sign in again.",
};

// Only http and https addresses become links (the address is the operator's setting, but a link is a click)
const isWebAddress = (value) => /^https?:\/\//i.test(String(value ?? ""));

export default function OpsPage({ token }) {
  const [data, setData] = useState(null);
  const [lastOkAt, setLastOkAt] = useState(null);
  const [refused, setRefused] = useState(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Bumped after a drill starts: the loop restarts, so the first look at the new events is at once
  const [refreshTick, setRefreshTick] = useState(0);

  // The loop's state is local to one run of the effect, so a new token starts a clean loop and
  // the old one ends, even if its request is still out
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let timer = null;

    async function load() {
      if (!alive || inFlight || document.hidden) return;
      inFlight = true;
      let refusedNow = false;
      try {
        const snapshot = await getOps(token);
        if (!alive) return;
        setData(snapshot);
        setLastOkAt(Date.now());
        setFailed(false);
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && REFUSED[error.status]) {
          refusedNow = true;
          alive = false;
          setRefused(REFUSED[error.status]);
        } else {
          setFailed(true);
        }
      } finally {
        inFlight = false;
        if (alive) {
          setNow(Date.now());
          // The next request only after this one ended, so two are never out at once
          if (!refusedNow && !document.hidden) timer = setTimeout(load, REFRESH_MS);
        }
      }
    }

    const onVisible = () => {
      clearTimeout(timer);
      if (!document.hidden) {
        setNow(Date.now());
        load();
      }
    };
    load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, refreshTick]);

  // A clock for "updated 3 s ago" and the stale banner
  useEffect(() => {
    let tick;
    const run = () => {
      setNow(Date.now());
      tick = setTimeout(run, TICK_MS);
    };
    tick = setTimeout(run, TICK_MS);
    return () => clearTimeout(tick);
  }, []);

  if (refused) {
    return (
      <section className="ops">
        <h1>Operations</h1>
        <p role="alert" className="ops-big">
          {refused}
        </p>
      </section>
    );
  }

  const age = lastOkAt === null ? null : now - lastOkAt;
  const stale = age !== null && age > STALE_MS;
  return (
    <section className="ops">
      <header className="ops-head">
        <h1>Operations</h1>
        <p>{age === null ? "Loading..." : `Updated ${agoText(age)}`}</p>
        {isWebAddress(data?.links?.grafana) && (
          <a href={data.links.grafana} target="_blank" rel="noreferrer">
            Open Grafana for the details
          </a>
        )}
      </header>
      {(stale || (failed && !data)) && (
        <p role="alert" className="ops-banner">
          {data
            ? "The data on screen is older than 15 seconds: the operations route is not answering."
            : "The operations route is not answering."}
        </p>
      )}
      {data && (
        <div className="ops-grid">
          <ContainersCard data={data} />
          <HpaCard data={data} />
          <NodesCard data={data} />
          <StorageCard data={data} />
          <TrafficCard data={data} />
          <DrillCard
            token={token}
            nextAllowedAt={data.drills?.nextAllowedAt ?? null}
            onStarted={() => setRefreshTick((n) => n + 1)}
          />
          <EventsCard data={data} />
          <LogsCard data={data} />
        </div>
      )}
    </section>
  );
}
