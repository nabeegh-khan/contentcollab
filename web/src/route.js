// Reads the page a `location.hash` asks for: the documents page, one version of one document (D28), or the operations page (D31).
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_ONLY = new RegExp(`^${UUID}$`, "i");
const VERSION_ADDRESS = new RegExp(`^#/documents/(${UUID})/versions/(${UUID})$`, "i");

export function parseHash(hash) {
  if (/^#\/ops\/?$/.test(hash ?? "")) return { name: "ops" };
  const match = VERSION_ADDRESS.exec(hash ?? "");
  if (!match) return { name: "documents" };
  return { name: "version", documentId: match[1], versionId: match[2] };
}

export function documentHash(documentId, versionId) {
  return `#/documents/${documentId}/versions/${versionId}`;
}

export function isId(value) {
  return ID_ONLY.test(value);
}
