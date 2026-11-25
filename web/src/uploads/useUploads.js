// The state of one batch of uploads for a page: the per-file lines, and whether a batch is running (D40).
// A second batch is not started while one runs; `start` then answers null.
import { useCallback, useRef, useState } from "react";
import { runUploads } from "./runUploads.js";

export function useUploads() {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const start = useCallback(async (files, options) => {
    if (running.current || files.length === 0) return null;
    running.current = true;
    setBusy(true);
    try {
      return await runUploads({ ...options, files, onUpdate: setItems });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return { items, busy, start };
}
