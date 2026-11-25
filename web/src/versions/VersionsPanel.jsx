// The versions of one document: list, open one, upload a new one, download one (D28; the routes are on main since #116).
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import { downloadVersion, listVersions, uploadVersion } from "../api/versions.js";
import { documentHash } from "../route.js";
import DropZone from "../uploads/DropZone.jsx";
import UploadList from "../uploads/UploadList.jsx";
import { useUploads } from "../uploads/useUploads.js";
import VersionCompare from "./VersionCompare.jsx";

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A readable reason for a refused call
function reason(error, what) {
  if (error instanceof ApiError) {
    if (error.status === 409) return "This file is already a version of the document.";
    if (error.status === 413) return "That file is too large: the limit is 50 MiB.";
    if (error.status === 403) return `Your role on this document cannot ${what}.`;
    if (error.status === 404 && what === "download")
      return "This version has no stored file to download.";
    if (error.status === 400)
      return "That file type is not allowed (PDF, images, Office files, text).";
  }
  return `Could not ${what}. Try again.`;
}

export default function VersionsPanel({ token, documentId, versionId }) {
  const [versions, setVersions] = useState([]);
  const [loadState, setLoadState] = useState("loading");
  const [problem, setProblem] = useState(null);
  const uploads = useUploads();
  const fileInput = useRef(null);

  const reload = useCallback(async () => {
    try {
      setVersions(await listVersions(token, documentId));
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [token, documentId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // One at a time, in the order of the list: a version's number is set when its request arrives (D40)
  async function uploadFiles(files) {
    const done = await uploads.start(files, {
      concurrency: 1,
      send: async (file) =>
        `Uploaded as version ${(await uploadVersion(token, documentId, file)).number}.`,
      reasonOf: (error) => reason(error, "upload"),
    });
    if (done?.some((item) => item.status === "done")) await reload();
  }

  async function upload() {
    const files = Array.from(fileInput.current?.files ?? []);
    if (files.length === 0) {
      setProblem("Choose a file first.");
      return;
    }
    setProblem(null);
    if (fileInput.current) fileInput.current.value = "";
    await uploadFiles(files);
  }

  function drop(files) {
    setProblem(null);
    return uploadFiles(files);
  }

  async function download(version) {
    setProblem(null);
    try {
      const blob = await downloadVersion(token, documentId, version.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = version.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setProblem(reason(error, "download"));
    }
  }

  return (
    <>
      <h3>Versions</h3>
      {loadState === "error" && (
        <p role="alert">Could not load the versions. Check your access and reload.</p>
      )}
      <ul className="versions">
        {versions.map((version) => (
          <li key={version.id}>
            <span>
              Version {version.number}: {version.filename} ({sizeText(version.size)})
            </span>{" "}
            {version.id === versionId ? (
              <strong>Viewing</strong>
            ) : (
              <a
                href={documentHash(documentId, version.id)}
                aria-label={`Open version ${version.number}`}
              >
                Open
              </a>
            )}{" "}
            <button
              type="button"
              aria-label={`Download version ${version.number}`}
              onClick={() => download(version)}
            >
              Download
            </button>
          </li>
        ))}
      </ul>
      <VersionCompare token={token} documentId={documentId} versions={versions} />
      <DropZone onFiles={drop} disabled={uploads.busy}>
        <label className="field">
          <span>New version (a file)</span>
          <input type="file" multiple ref={fileInput} />
        </label>
      </DropZone>
      {problem && <p role="alert">{problem}</p>}
      <button type="button" className="primary" disabled={uploads.busy} onClick={upload}>
        Upload as a new version
      </button>
      <UploadList items={uploads.items} />
    </>
  );
}
