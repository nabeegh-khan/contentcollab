// The four comment routes on main (docs/API.md, Comments), on the shared request() helper.
import { request } from "./client.js";

const PAGE_SIZE = 100; // the API default is 20 and its maximum 100
const MAX_PAGES = 50; // a stop for a server that never returns a null cursor

function versionPath(documentId, versionId) {
  return `/documents/${documentId}/versions/${versionId}/comments`;
}

// Every comment of one version, oldest first: follows nextCursor until the API returns null
export async function listComments(token, documentId, versionId) {
  const base = versionPath(documentId, versionId);
  const all = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `?limit=${PAGE_SIZE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const answer = await request(`${base}${query}`, { token });
    all.push(...answer.items);
    if (!answer.nextCursor) break;
    cursor = answer.nextCursor;
  }
  return all;
}

export function createComment(token, documentId, versionId, { body, parentId }) {
  const payload = parentId ? { body, parentId } : { body };
  return request(versionPath(documentId, versionId), { method: "POST", body: payload, token });
}

// `changes` is { body } or { resolved }; a resolve is stored on the thread root
export function updateComment(token, documentId, commentId, changes) {
  return request(`/documents/${documentId}/comments/${commentId}`, {
    method: "PATCH",
    body: changes,
    token,
  });
}

export function deleteComment(token, documentId, commentId) {
  return request(`/documents/${documentId}/comments/${commentId}`, { method: "DELETE", token });
}
