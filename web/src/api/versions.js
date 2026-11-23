// The version routes on main (docs/API.md, Versions): list, upload a new version, download one.
import { API_BASE, ApiError, request } from "./client.js";

export async function listVersions(token, documentId) {
  const answer = await request(`/documents/${documentId}/versions`, { token });
  return Array.isArray(answer) ? answer : answer.items;
}

// `file` is a File from an <input type="file">; FormData goes without a Content-Type so the browser sets the boundary
export function uploadVersion(token, documentId, file) {
  const form = new FormData();
  form.append("file", file);
  return request(`/documents/${documentId}/versions`, { method: "POST", body: form, token });
}

// The line diff of two text versions (D33): { from, to, added, removed, lines }; 415 when a version is not text
export function compareVersions(token, documentId, from, to) {
  return request(`/documents/${documentId}/versions/compare?from=${from}&to=${to}`, { token });
}

// The file's bytes as a Blob; the content route answers with the file itself, not JSON, so request() does not fit
export async function downloadVersion(token, documentId, versionId) {
  const response = await fetch(
    `${API_BASE}/documents/${documentId}/versions/${versionId}/content`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      // not JSON: the status alone is kept
    }
    throw new ApiError(response.status, body);
  }
  return response.blob();
}
