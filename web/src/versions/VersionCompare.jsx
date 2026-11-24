// "Compare versions" on the document page (#23, D33): two versions chosen, the line diff shown with a sign and a word
// on every changed line (not colour alone). A file that is not text gets a message and the two versions side by side.
import { useState } from "react";
import { ApiError } from "../api/client.js";
import { compareVersions } from "../api/versions.js";

const MARKS = {
  keep: { sign: " ", word: "" },
  remove: { sign: "−", word: "Removed" },
  add: { sign: "+", word: "Added" },
};

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// A readable reason for a refused comparison
function reason(error) {
  if (error instanceof ApiError) {
    if (error.status === 415)
      return "Only text and Markdown versions can be compared line by line. Open or download the files to see the difference.";
    if (error.status === 413)
      return "These versions are too large to compare line by line (about 2,000 lines or 2 MiB each at most).";
    if (error.status === 404 || error.status === 403)
      return "These versions could not be found or are not shared with you.";
  }
  return "Could not compare the versions. Try again.";
}

function DiffList({ result }) {
  const same = result.added === 0 && result.removed === 0;
  return (
    <>
      <p role="status">
        {same
          ? `Version ${result.from.number} and version ${result.to.number} have the same text.`
          : `Version ${result.from.number} to version ${result.to.number}: ${plural(result.added, "line")} added, ${plural(result.removed, "line")} removed`}
      </p>
      <ul className="diff" aria-label="Differences">
        {result.lines.map((line, index) => {
          const mark = MARKS[line.op];
          return (
            <li key={index} className={`diff-${line.op}`}>
              <span aria-hidden="true" className="diff-sign">
                {mark.sign}
              </span>
              {mark.word && <span className="diff-word">{mark.word}: </span>}
              <code>{line.text}</code>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function SideBySide({ versions }) {
  return (
    <div role="group" aria-label="Side by side" className="diff-sides">
      {versions.map((v, index) => (
        <p key={v.id}>
          {index === 0 ? "From" : "To"}: version {v.number}, {v.filename}
        </p>
      ))}
    </div>
  );
}

export default function VersionCompare({ token, documentId, versions }) {
  const ordered = [...versions].sort((a, b) => a.number - b.number);
  // A choice the user has not made stays the default (oldest to newest), so a list that arrives late still works
  const [chosenFrom, setFrom] = useState("");
  const [chosenTo, setTo] = useState("");
  const from = chosenFrom || ordered[0]?.id || "";
  const to = chosenTo || ordered[ordered.length - 1]?.id || "";
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  if (ordered.length < 2) return <p>Compare versions needs at least two versions.</p>;

  // A new choice drops the old answer, so a diff is never shown under versions it does not cover
  function choose(set, value) {
    set(value);
    setResult(null);
    setProblem(null);
  }

  async function run() {
    setProblem(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await compareVersions(token, documentId, from, to));
    } catch (error) {
      setProblem(reason(error));
    } finally {
      setBusy(false);
    }
  }

  const options = ordered.map((v) => (
    <option key={v.id} value={v.id}>
      #{v.number}
    </option>
  ));
  const chosen = [from, to].map((id) => ordered.find((v) => v.id === id));
  return (
    <section aria-labelledby="compare-heading">
      <h3 id="compare-heading">Compare versions</h3>
      <label className="field">
        <span>From version</span>
        <select value={from} onChange={(e) => choose(setFrom, e.target.value)}>
          {options}
        </select>
      </label>
      <label className="field">
        <span>To version</span>
        <select value={to} onChange={(e) => choose(setTo, e.target.value)}>
          {options}
        </select>
      </label>
      <button type="button" disabled={busy || from === to} onClick={run}>
        Compare
      </button>
      {from === to && <p>Choose two different versions.</p>}
      {problem && (
        <>
          <p role="alert">{problem}</p>
          <SideBySide versions={chosen} />
        </>
      )}
      {result && <DiffList result={result} />}
    </section>
  );
}
