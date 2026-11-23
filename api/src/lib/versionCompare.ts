// Compares two versions of one document as text (#23, ARCHITECTURE D33): which versions may be compared and
// what comes back. The database and the object store are reached through `deps`, so the rules are testable alone.
import { DiffTooLargeError, lineDiff, type DiffLine } from "./diff.js";
import { HttpError } from "./httpError.js";
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_UNSUPPORTED_MEDIA_TYPE,
} from "./httpStatus.js";

/** Types compared as lines of text: the two text types the upload route allows. */
export const TEXT_TYPES = ["text/plain", "text/markdown"];
const BYTES_PER_MIB = 1_048_576;
const MAX_VERSION_MIB = 2;
/** A version above this many bytes is not read for a comparison (2 MiB). */
export const MAX_VERSION_BYTES = MAX_VERSION_MIB * BYTES_PER_MIB;

export interface VersionRow {
  id: string;
  number: number;
  filename: string;
  contentType: string;
  size: number;
  objectKey: string;
}

export interface CompareDeps {
  /** The version with this id in this document, or null (another document's version counts as none). */
  loadVersion: (documentId: string, versionId: string) => Promise<VersionRow | null>;
  /** The stored file as UTF-8 text. */
  readText: (objectKey: string) => Promise<string>;
}

export interface VersionSummary {
  id: string;
  number: number;
  filename: string;
}

export interface Comparison {
  from: VersionSummary;
  to: VersionSummary;
  added: number;
  removed: number;
  lines: DiffLine[];
}

const summary = ({ id, number, filename }: VersionRow): VersionSummary => ({
  id,
  number,
  filename,
});

async function load(documentId: string, id: string, deps: CompareDeps): Promise<VersionRow> {
  const found = await deps.loadVersion(documentId, id);
  if (!found) throw new HttpError(HTTP_NOT_FOUND, "NOT_FOUND", "Version Not Found");
  return found;
}

function checkComparable(version: VersionRow): void {
  if (!TEXT_TYPES.includes(version.contentType)) {
    throw new HttpError(
      HTTP_UNSUPPORTED_MEDIA_TYPE,
      "UNSUPPORTED_TYPE",
      `Version ${version.number} is not a text file: only text and Markdown can be compared`,
    );
  }
  if (version.size > MAX_VERSION_BYTES) {
    throw new HttpError(
      HTTP_PAYLOAD_TOO_LARGE,
      "TOO_LARGE",
      `Version ${version.number} is too large to compare`,
    );
  }
}

export async function compareVersions(
  documentId: string,
  fromId: string,
  toId: string,
  deps: CompareDeps,
): Promise<Comparison> {
  if (fromId === toId) {
    throw new HttpError(HTTP_BAD_REQUEST, "VALIDATION", "Choose two different versions", [
      { field: "to", message: "must differ from from" },
    ]);
  }
  const [from, to] = await Promise.all([
    load(documentId, fromId, deps),
    load(documentId, toId, deps),
  ]);
  checkComparable(from);
  checkComparable(to);
  const [before, after] = await Promise.all([
    deps.readText(from.objectKey),
    deps.readText(to.objectKey),
  ]);
  try {
    const diff = lineDiff(before, after);
    return { from: summary(from), to: summary(to), ...diff };
  } catch (error) {
    if (error instanceof DiffTooLargeError) {
      throw new HttpError(
        HTTP_PAYLOAD_TOO_LARGE,
        "TOO_LARGE",
        "The versions are too large to compare",
      );
    }
    throw error;
  }
}
