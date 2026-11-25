// A frame that takes files dropped on it and hands them to the page as an array (D40).
// The browser needs dragover cancelled before it fires drop; the picker inside stays the keyboard path.
import { useState } from "react";

const carriesFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

export default function DropZone({ onFiles, disabled = false, children }) {
  const [dragging, setDragging] = useState(false);

  function over(event) {
    event.preventDefault();
  }

  function enter(event) {
    event.preventDefault();
    if (!disabled && carriesFiles(event)) setDragging(true);
  }

  function leave(event) {
    event.preventDefault();
    // moving onto a child of the zone also fires dragleave on the zone; the files are still over it
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  }

  function drop(event) {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!disabled && files.length > 0) onFiles(files);
  }

  return (
    <div
      className="dropzone"
      role="group"
      aria-label="Drop files here to upload"
      aria-disabled={disabled ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      onDragEnter={enter}
      onDragOver={over}
      onDragLeave={leave}
      onDrop={drop}
    >
      <p className="dropzone-hint">Drop files here, or choose them below.</p>
      {children}
    </div>
  );
}
