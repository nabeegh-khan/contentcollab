// A small form to share a document with a user by email and a role (#114's POST /documents/:id/shares).
import { useEffect, useState } from "react";
import { createShare } from "../api/shares.js";
import { ApiError } from "../api/client.js";
import { useToasts } from "../toasts/ToastProvider.jsx";

const ROLES = ["viewer", "commenter", "editor"];

// What each refusal means for the person at the form
function refusal(error) {
  if (error instanceof ApiError) {
    if (error.status === 404)
      return "No user has that email, or you have no access to this document.";
    if (error.status === 409) return "That user already has a share on this document.";
    if (error.status === 401) return "Your session has ended. Sign out and sign in again.";
    if (error.status === 403) return "Only the owner of a document can share it.";
    return error.message;
  }
  return "Something went wrong. Try again.";
}

// `documentId` is the document chosen in the list ("Share" on a row); it fills the id field and the field stays editable.
// `choiceCount` rises with every click, so choosing the same document again refills the field.
export default function ShareForm({ token, documentId: chosen = "", choiceCount = 0 }) {
  const [documentId, setDocumentId] = useState(chosen);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [problem, setProblem] = useState(null);
  const { notify } = useToasts();

  useEffect(() => {
    if (!chosen) return;
    setDocumentId(chosen);
    setDone(null);
    setProblem(null);
  }, [chosen, choiceCount]);

  // Editing a field drops the last message, so a stale "Shared" never sits beside new input
  function edit(setter, value) {
    setDone(null);
    setProblem(null);
    setter(value);
  }

  async function submit(event) {
    event.preventDefault();
    setDone(null);
    setProblem(null);
    const doc = documentId.trim();
    const who = email.trim();
    if (!doc || !who) {
      setProblem("Enter a document id and an email.");
      return;
    }
    setBusy(true);
    try {
      await createShare(token, doc, { email: who, role });
      const sent = `Shared with ${who} as ${role}.`;
      setDone(sent);
      notify({ kind: "success", text: sent });
    } catch (error) {
      setProblem(refusal(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>Share a document</h3>
      <form onSubmit={submit}>
        <label className="field">
          <span>Id of the document to share</span>
          <input
            type="text"
            value={documentId}
            onChange={(e) => edit(setDocumentId, e.target.value)}
          />
        </label>
        <label className="field">
          <span>Email of the user</span>
          <input type="email" value={email} onChange={(e) => edit(setEmail, e.target.value)} />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => edit(setRole, e.target.value)}>
            {ROLES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {problem && <p role="alert">{problem}</p>}
        {done && <p className="success">{done}</p>}
        <button type="submit" disabled={busy}>
          Share
        </button>
      </form>
    </section>
  );
}
