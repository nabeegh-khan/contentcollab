// The app shell: sign-in gate, the signed-in pages, and the footer status dot.
import { useEffect, useState } from "react";
import App from "./App.jsx";
import { me } from "./api/auth.js";
import { ApiError } from "./api/client.js";
import AuthPage from "./pages/AuthPage.jsx";
import DocumentPage from "./pages/DocumentPage.jsx";
import DocumentsPage from "./pages/DocumentsPage.jsx";
import { clearToken, loadToken, saveToken } from "./session.js";
import { useRoute } from "./useRoute.js";
import "./app.css";

const SIGNED_OUT = { status: "signedOut", user: null };

function useSession() {
  const [session, setSession] = useState(() =>
    loadToken() ? { status: "checking", user: null } : SIGNED_OUT,
  );

  // A stored token is only trusted once /auth/me accepts it; a 401 drops it,
  // any other failure keeps it for the next load and shows sign-in
  useEffect(() => {
    const token = loadToken();
    if (!token) return undefined;
    let ignore = false;
    me(token)
      .then((user) => {
        if (!ignore) setSession({ status: "signedIn", user });
      })
      .catch((error) => {
        if (ignore) return;
        if (error instanceof ApiError && error.status === 401) clearToken();
        setSession(SIGNED_OUT);
      });
    return () => {
      ignore = true;
    };
  }, []);

  function signIn({ token, user }) {
    saveToken(token);
    setSession({ status: "signedIn", user });
  }

  function signOut() {
    clearToken();
    setSession(SIGNED_OUT);
  }

  return { session, signIn, signOut };
}

function SignedInPage({ route, token, user }) {
  if (route.name === "version") {
    return (
      <DocumentPage
        key={route.versionId}
        token={token}
        user={user}
        documentId={route.documentId}
        versionId={route.versionId}
      />
    );
  }
  return <DocumentsPage />;
}

export default function Root() {
  const { session, signIn, signOut } = useSession();
  const route = useRoute();

  return (
    <div className="shell">
      <header className="bar">
        <strong>ContentCollab</strong>
        {session.status === "signedIn" && (
          <span className="who">
            <span>Signed in as {session.user.displayName}</span>
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </span>
        )}
      </header>
      <main>
        {session.status === "checking" && <p>Checking your sign-in...</p>}
        {session.status === "signedOut" && <AuthPage onSignedIn={signIn} />}
        {session.status === "signedIn" && (
          <SignedInPage route={route} token={loadToken()} user={session.user} />
        )}
      </main>
      <footer className="bar">
        <App />
      </footer>
    </div>
  );
}
