// The restart drill card (D31): ask first, then evict one pod, and watch Kubernetes replace it.
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import { startDrill } from "./api.js";

const TICK_MS = 1000;
const MS_PER_SECOND = 1000;

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

// What the person sees for a refusal: the server's own sentence (it is plain), or a fallback
function refusal(error) {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Try again.";
}

export default function DrillCard({ token, nextAllowedAt, onStarted }) {
  const [asking, setAsking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [problem, setProblem] = useState(null);
  const [localNext, setLocalNext] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const sending = useRef(false);
  const cancelButton = useRef(null);

  useEffect(() => {
    let tick;
    const run = () => {
      setNow(Date.now());
      tick = setTimeout(run, TICK_MS);
    };
    tick = setTimeout(run, TICK_MS);
    return () => clearTimeout(tick);
  }, []);

  // Cancel has the focus when the dialog opens, so Enter never starts a drill by accident
  useEffect(() => {
    if (asking) cancelButton.current?.focus();
  }, [asking]);

  const nextAt = [nextAllowedAt, localNext]
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .reduce((a, b) => Math.max(a, b), 0);
  const waitSeconds = Math.max(0, Math.ceil((nextAt - Math.max(now, Date.now())) / MS_PER_SECOND));

  async function confirm() {
    if (sending.current || !asking) return;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await startDrill(token, asking);
      setDone(
        `Kubernetes is stopping pod ${result.pod}. A new one will start: watch the events below.`,
      );
      setLocalNext(result.nextAllowedAt);
      setAsking(null);
      onStarted();
    } catch (error) {
      setDone(null);
      setProblem(refusal(error));
      setAsking(null);
    } finally {
      sending.current = false;
      setBusy(false);
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
          onClick={() => setAsking(target)}
        >
          {choice.button}
        </button>
      ))}
      {waitSeconds > 0 && <p>Next drill allowed in {waitSeconds} s</p>}
      {done && <p role="status">{done}</p>}
      {problem && <p role="alert">{problem}</p>}
      {asking && (
        <div
          className="ops-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ops-dialog-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") setAsking(null);
          }}
        >
          <h3 id="ops-dialog-title">{CHOICES[asking].question}</h3>
          <p>{CHOICES[asking].text}</p>
          <button type="button" ref={cancelButton} onClick={() => setAsking(null)}>
            Cancel
          </button>{" "}
          <button type="button" className="ops-danger" disabled={busy} onClick={confirm}>
            Restart
          </button>
        </div>
      )}
    </section>
  );
}
