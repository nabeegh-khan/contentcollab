// Keeps the API token for this browser tab in sessionStorage; blocked storage means nothing is remembered.
const KEY = "contentcollab.token";

export function loadToken() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveToken(token) {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Storage blocked (private mode, site data off): the session lasts until the page reloads
  }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing was stored
  }
}
