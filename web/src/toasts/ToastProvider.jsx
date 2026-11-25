// Short notifications for state changes (D40, #192): at most three, each goes by itself, one polite live region.
// A toast with the text of one already shown renews that one instead of stacking.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export const MAX_TOASTS = 3;
const SHOWN_MS = { info: 5000, success: 5000, error: 8000 };

// Where no provider is mounted (a component under test), notifying does nothing
const ToastContext = createContext({ notify: () => {} });

export const useToasts = () => useContext(ToastContext);

// Each toast owns its timer; a new `stamp` (a renewal) restarts it, and unmounting clears it
function Toast({ toast, onDone }) {
  useEffect(() => {
    const timer = setTimeout(() => onDone(toast.id), SHOWN_MS[toast.kind] ?? SHOWN_MS.info);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, toast.stamp, onDone]);

  return (
    <li data-kind={toast.kind}>
      <span>{toast.text}</span>
      <button type="button" onClick={() => onDone(toast.id)}>
        Dismiss
      </button>
    </li>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  const remove = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const notify = useCallback(({ kind = "info", text }) => {
    const stamp = ++counter.current;
    setToasts((list) => {
      const same = list.find((t) => t.text === text);
      if (same) return list.map((t) => (t === same ? { ...t, kind, stamp } : t));
      return [...list, { id: stamp, stamp, kind, text }].slice(-MAX_TOASTS);
    });
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        <ul>
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} onDone={remove} />
          ))}
        </ul>
      </div>
    </ToastContext.Provider>
  );
}
