// The operations page (D31): what kubectl would show, as cards that refresh every 5 s, for an operator.
import { useCallback, useEffect, useRef, useState } from "react";
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

export default function OpsPage({ token }) {
  const [data, setData] = useState(null);
  const [lastOkAt, setLastOkAt] = useState(null);
  const [refused, setRefused] = useState(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef(null);
  const inFlight = useRef(false);
  const stopped = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current || stopped.current || document.hidden) return;
    inFlight.current = true;
    try {
      setData(await getOps(token));
      setLastOkAt(Date.now());
      setFailed(false);
    } catch (error) {
      if (error instanceof ApiError && REFUSED[error.status]) {
        stopped.current = true;
        setRefused(REFUSED[error.status]);
      } else {
        setFailed(true);
      }
    } finally {
      inFlight.current = false;
      setNow(Date.now());
      // The next request only after this one ended, so two are never out at once
      if (!stopped.current && !document.hidden) timer.current = setTimeout(load, REFRESH_MS);
    }
  }, [token]);

  useEffect(() => {
    stopped.current = false;
    load();
    const onVisible = () => {
      clearTimeout(timer.current);
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped.current = true;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

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
        {data?.links?.grafana && (
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
          <EventsCard data={data} />
          <LogsCard data={data} />
        </div>
      )}
    </section>
  );
}
