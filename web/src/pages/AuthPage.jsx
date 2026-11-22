// Sign in, or register and then sign in, against /api/v1/auth; reports the API's errors as text.
import { useState } from "react";
import { login, register } from "../api/auth.js";
import { ApiError } from "../api/client.js";

function errorLines(error) {
  if (!(error instanceof ApiError)) return ["Could not reach the server."];
  return [error.message, ...error.details.map((d) => `${d.field}: ${d.message}`)];
}

// `name` and `autoComplete` are what Chrome's password manager reads to save and fill the login
function Field({ label, name, type = "text", value, onChange, autoComplete }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        name={name}
        value={value}
        autoComplete={autoComplete}
        required
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export default function AuthPage({ onSignedIn }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const registering = mode === "register";

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setErrors([]);
    try {
      if (registering) {
        await register({ email, password, displayName });
        // The account exists now: a retry after a failed sign-in signs in, not registers again
        setMode("signin");
      }
      onSignedIn(await login({ email, password }));
    } catch (error) {
      setErrors(errorLines(error));
      setBusy(false);
    }
  }

  return (
    <section className="card auth">
      <h1>{registering ? "Register" : "Sign in"}</h1>
      <form onSubmit={submit}>
        <Field
          label="Email"
          name="email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
        />
        <Field
          label="Password"
          name="password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete={registering ? "new-password" : "current-password"}
        />
        {registering && (
          <Field
            label="Display name"
            name="displayName"
            value={displayName}
            onChange={setDisplayName}
            autoComplete="name"
          />
        )}
        {errors.length > 0 && (
          <div role="alert" className="error">
            {errors.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
        )}
        <button type="submit" disabled={busy}>
          {registering ? "Create account" : "Sign in"}
        </button>
      </form>
      <button
        type="button"
        className="link"
        onClick={() => {
          setMode(registering ? "signin" : "register");
          setErrors([]);
        }}
      >
        {registering ? "Have an account? Sign in" : "Need an account? Register"}
      </button>
    </section>
  );
}
