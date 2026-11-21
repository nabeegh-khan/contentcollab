// The restart drill card (D31): ask first, then evict one pod, and watch Kubernetes replace it.
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import { startDrill } from "./api.js";

const TICK_MS = 1000;
const MS_PER_SECOND = 1000;
const UNAUTHORIZED = 401;

const CHOICES = {
  api: {
    button: "Restart an API pod",
    question: "Restart an API pod?",
    text: "One API pod will stop. Kubernetes will start a new one. Users are not affected: the other pod keeps serving.",
  },
  postgres: {
    button: "Restart the database pod",
    question: "Restart the database pod?",
    text: "The database pod will stop and Kubernetes will start it again. The app pauses for about 30 seconds. Data stays on its volume.",
  },
};

// What the person sees for a refusal: the server's own sentence (it is plain), or a plain fallback
function refusal(error) {
  if (error instanceof ApiError) {
    if (error.status === UNAUTHORIZED) return "Your session has ended. Sign out and sign in again.";
    // No code means the answer was not the API's JSON (a proxy's page): its text would not be a sentence
    if (error.code === null) return "The server did not answer. Try again.";
    return error.message;
  }
  return "Something went wrong. Try again.";
}

const toMs = (iso) => {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? ms : null;
};

export default function DrillCard({ token, nextAllowedAt, onStarted }) {
  const [asking, setAsking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [problem, setProblem] = useState(null);
  const [localDeadline, setLocalDeadline] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const sending = useRef(false);
  const cancelButton = useRef(null);
  const restartButton = useRef(null);
  const opener = useRef(null);
  const status = useRef(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    let tick;
    const run = () => {
      setNow(Date.now());
      tick = setTimeout(run, TICK_MS);
    };
    tick = setTimeout(run, TICK_MS);
    return () => clearTimeout(tick);
  }, []);

  // Cancel has the focus when the dialog opens, so Enter never starts a drill by accident; Escape closes
  // it wherever the focus is
  useEffect(() => {
    if (!asking) return undefined;
    cancelButton.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking]);

  // After a drill the buttons are disabled, so the result message takes the focus
  useEffect(() => {
    if (done) status.current?.focus();
  }, [done]);

  // Back to the button that opened the dialog, once the dialog's own buttons are gone
  useEffect(() => {
    if (!asking && returnFocus.current) {
      returnFocus.current = false;
      opener.current?.focus();
    }
  }, [asking]);

  function close() {
    returnFocus.current = true;
    setAsking(null);
  }

  // The server's time for the snapshot's value; the deadline of a drill started here is counted from
  // this browser's clock using the server's own interval, so a wrong laptop clock cannot lock the card
  const serverNext = toMs(nextAllowedAt);
  const deadline = Math.max(serverNext ?? 0, localDeadline ?? 0);
  const waitSeconds = Math.max(
    0,
    Math.ceil((deadline - Math.max(now, Date.now())) / MS_PER_SECOND),
  );

  function keepTabInside(event) {
    if (event.key !== "Tab") return;
    const active = document.activeElement;
    if (event.shiftKey && active === cancelButton.current) {
      event.preventDefault();
      restartButton.current?.focus();
    } else if (!event.shiftKey && active === restartButton.current) {
      event.preventDefault();
      cancelButton.current?.focus();
    }
  }

  async function confirm() {
    if (sending.current || !asking) return;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    let result;
    try {
      result = await startDrill(token, asking);
    } catch (error) {
      setDone(null);
      setProblem(refusal(error));
      returnFocus.current = true;
      setAsking(null);
      return;
    } finally {
      sending.current = false;
      setBusy(false);
    }
    const interval = (toMs(result.nextAllowedAt) ?? NaN) - (toMs(result.startedAt) ?? NaN);
    setLocalDeadline(Number.isFinite(interval) ? Date.now() + interval : null);
    setDone(
      `Kubernetes is stopping pod ${result.pod ?? "a pod"}. A new one will start: watch the events below.`,
    );
    setAsking(null);
    try {
      onStarted?.();
    } catch {
      // The drill has started; a failing refresh hook must not read as a refusal
    }
  }

  return (
    <section className="ops-card" aria-labelledby="ops-restart-a-pod">
      <h2 id="ops-restart-a-pod">Restart a pod</h2>
      <p>Stop one pod on purpose and watch Kubernetes replace it while the data stays.</p>
      {Object.entries(CHOICES).map(([target, choice]) => (
        <button
          key={target}
          type="button"
          className="ops-action"
          disabled={waitSeconds > 0 || busy}
          onClick={(event) => {
            opener.current = event.currentTarget;
            setAsking(target);
          }}
        >
          {choice.button}
        </button>
      ))}
      {waitSeconds > 0 && <p>Next drill allowed in {waitSeconds} s</p>}
      {done && (
        <p role="status" tabIndex={-1} ref={status}>
          {done}
        </p>
      )}
      {problem && <p role="alert">{problem}</p>}
      {asking && (
        <div
          className="ops-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ops-dialog-title"
          onKeyDown={keepTabInside}
        >
          <h3 id="ops-dialog-title">{CHOICES[asking].question}</h3>
          <p>{CHOICES[asking].text}</p>
          <button type="button" ref={cancelButton} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            ref={restartButton}
            className="ops-danger"
            disabled={busy || waitSeconds > 0}
            onClick={confirm}
          >
            Restart
          </button>
        </div>
      )}
    </section>
  );
}
