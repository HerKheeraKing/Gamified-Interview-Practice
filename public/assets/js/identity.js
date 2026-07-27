/**
 * identity.js
 * ------------------------------------------------------------
 * Who the detective is, and how their entries reach the server.
 *
 * Structure:
 *   1. Identity  - the saved username + session token
 *   2. Api       - the only place that speaks HTTP
 *
 * Loaded before app.js. app.js's Storage layer is the sole consumer —
 * nothing in the render or scoring code knows a network exists.
 *
 * Signing in is optional by design. With no identity saved, both
 * modules report "signed out" and every call is a cheap no-op, so the
 * site runs exactly as it did before sync existed.
 * ------------------------------------------------------------
 */

/* ---------------------------------------------------------- */
/* 1. IDENTITY                                                 */
/* ---------------------------------------------------------- */

const Identity = (() => {
  const KEY = "caseFiles.identity.v1";

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error("Identity read failed:", err);
      return null;
    }
  }

  function save(identity) {
    try {
      localStorage.setItem(KEY, JSON.stringify(identity));
    } catch (err) {
      console.error("Identity write failed:", err);
    }
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  function isSignedIn() {
    const id = read();
    return Boolean(id && id.token);
  }

  function username() {
    const id = read();
    return id ? id.username : null;
  }

  function token() {
    const id = read();
    return id ? id.token : null;
  }

  return { read, save, clear, isSignedIn, username, token };
})();

/* ---------------------------------------------------------- */
/* 2. API                                                      */
/* ---------------------------------------------------------- */

const Api = (() => {
  /**
   * Sign in (creating the account if it's new) and hand back the
   * server's copy of the log in the same round trip.
   * Resolves to { username, log } or throws with a readable message.
   */
  async function signIn(username, password) {
    const res = await send("/api/session", "POST", { username, password });
    Identity.save({ username: res.username, token: res.token });
    return { username: res.username, log: res.log };
  }

  /** Server log, or null when signed out / unreachable. */
  async function pullLog() {
    return attempt(() => send("/api/log", "GET"));
  }

  /** Push entries, receive the merged authoritative log. Null on failure. */
  async function pushLog(entries) {
    return attempt(() => send("/api/log", "POST", { entries }));
  }

  /** Wipe the server-side log. Null on failure. */
  async function clearLog() {
    return attempt(() => send("/api/log", "DELETE"));
  }

  /**
   * Sync is best-effort: a dead network must never break the local
   * experience, so failures collapse to null and are logged, not thrown.
   * Only signIn (where the user is watching) reports errors upward.
   *
   * A rejected token is the exception worth acting on — it means the
   * session is gone for good, so we drop it rather than retrying it on
   * every page load forever.
   */
  async function attempt(call) {
    if (!Identity.isSignedIn()) {
      return null;
    }
    try {
      const res = await call();
      return res.log;
    } catch (err) {
      if (err.status === 401) {
        Identity.clear();
      }
      console.warn("Sync unavailable:", err.message);
      return null;
    }
  }

  async function send(path, method, body) {
    const headers = { "content-type": "application/json" };
    const token = Identity.token();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return { signIn, pullLog, pushLog, clearLog };
})();
