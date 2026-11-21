// The auth routes on main: register, login and the signed-in user (docs/API.md, Auth).
import { request } from "./client.js";

export function register({ email, password, displayName }) {
  return request("/auth/register", { method: "POST", body: { email, password, displayName } });
}

// Resolves to { token, user }
export function login({ email, password }) {
  return request("/auth/login", { method: "POST", body: { email, password } });
}

export function me(token) {
  return request("/auth/me", { token });
}
