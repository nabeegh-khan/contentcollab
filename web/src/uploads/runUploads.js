// Uploads a list of files, one request per file, each with its own state (D40).
// `send(file)` makes the request and returns the text for a finished file; `reasonOf(error)` turns a failure into text.
// `concurrency` is how many requests may be in flight at once (1 keeps the order of the list).
import { validateFile } from "./validateFile.js";

export async function runUploads({ files, send, reasonOf, concurrency, onUpdate = () => {} }) {
  const items = files.map((file, index) => ({
    id: index,
    name: file.name,
    status: "waiting",
    message: "",
  }));
  const publish = () => onUpdate(items.map((item) => ({ ...item })));
  const change = (index, status, message = "") => {
    items[index] = { ...items[index], status, message };
    publish();
  };

  // A refused file is settled before anything is sent, so it never takes a place in the queue
  const queue = [];
  files.forEach((file, index) => {
    const refusal = validateFile(file);
    if (refusal) items[index] = { ...items[index], status: "failed", message: refusal };
    else queue.push(index);
  });
  publish();

  async function worker() {
    while (queue.length > 0) {
      const index = queue.shift();
      change(index, "uploading");
      try {
        change(index, "done", await send(files[index]));
      } catch (error) {
        change(index, "failed", reasonOf(error));
      }
    }
  }

  const workers = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return items.map((item) => ({ ...item }));
}
