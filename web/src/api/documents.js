// The document routes on main (docs/API.md, Documents): list a page of the caller's documents, create one with its first version.
import { request } from "./client.js";

const PAGE_SIZE = 20;

// A page is { items, nextCursor }; nextCursor is null on the last page
export function listDocuments(token, { cursor } = {}) {
  const cursorPart = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  return request(`/documents?limit=${PAGE_SIZE}${cursorPart}`, { token });
}

// `file` is a File from an <input type="file">; a blank title is left out so the API uses the file name.
// FormData goes without a Content-Type so the browser sets the boundary.
export function createDocument(token, file, title) {
  const form = new FormData();
  form.append("file", file);
  const trimmed = (title ?? "").trim();
  if (trimmed) form.append("title", trimmed);
  return request("/documents", { method: "POST", body: form, token });
}
