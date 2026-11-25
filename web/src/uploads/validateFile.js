// The browser-side check of one file, with the limits of api/src/lib/parseUpload.ts (D40). The API checks again;
// this saves a round trip and gives the reason in words. A limit the API does not set is not set here.
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

const TYPES_BY_EXTENSION = {
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
};

export const ALLOWED_EXTENSIONS = Object.keys(TYPES_BY_EXTENSION);

export const NOT_ALLOWED = `That file type is not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`;
export const TOO_LARGE = "That file is too large: the limit is 50 MiB.";
const NO_TYPE = "The browser did not report a type for this file, so it cannot be uploaded.";

// The extension the way the API reads it: from the last dot, lower case, none for a leading dot only
function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

// null when the file may be sent, otherwise the reason
export function validateFile(file) {
  const types = TYPES_BY_EXTENSION[extensionOf(file.name)];
  if (!types) return NOT_ALLOWED;
  if (file.type === "") return NO_TYPE;
  if (!types.includes(file.type)) return NOT_ALLOWED;
  if (file.size > MAX_FILE_SIZE) return TOO_LARGE;
  return null;
}
