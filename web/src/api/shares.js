// The share route on main (docs/API.md, Shares): share a document with one user by email, on request().
import { request } from "./client.js";

// Resolves to the new Share; the API answers 404 (no such user), 409 (already shared), 403 (not the owner)
export function createShare(token, documentId, { email, role }) {
  return request(`/documents/${encodeURIComponent(documentId)}/shares`, {
    method: "POST",
    body: { email, role },
    token,
  });
}
