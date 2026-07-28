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

  /**
   * What the server last said about this account's AI access:
   * { tier: "owner" | "invited" | "free", ai, cap?, spent?, remaining? }.
   *
   * A cached answer, and treated as one. It is here so the two AI modes
   * can be greyed out before a click rather than after a failed request,
   * which is a nicer thing to look at but not a security boundary — the
   * Worker re-checks the tier on every /api/coach call and does not
   * consult this. Editing it in devtools changes what the buttons look
   * like and nothing about what they can spend.
   *
   * Signed out reads as free, because a request with no token cannot
   * reach the coach anyway.
   */
  function access() {
    const id = read();
    if (!id || !id.token) {
      return { tier: "free", ai: false };
    }
    return id.access || { tier: "free", ai: false };
  }

  /** Fold a fresh access summary into the stored identity. */
  function setAccess(summary) {
    const id = read();
    if (!id) {
      return;
    }
    save({ ...id, access: summary || { tier: "free", ai: false } });
  }

  function canCoach() {
    return isSignedIn() && access().ai === true;
  }

  return { read, save, clear, isSignedIn, username, token, access, setAccess, canCoach };
})();

/* ---------------------------------------------------------- */
/* 2. API                                                      */
/* ---------------------------------------------------------- */

const Api = (() => {
  /**
   * Sign in (creating the account if it's new) and hand back the
   * server's copy of the log in the same round trip.
   *
   * `code` is optional: an invite code for a beta tester, the passphrase
   * for the owner account, or nothing at all for the free tier, which is
   * the common case and a perfectly good place to be.
   *
   * Resolves to { username, log, access } or throws with a readable
   * message. Wrong code and wrong passphrase both surface as the
   * server's own sentence, because they are different problems.
   */
  async function signIn(username, code) {
    const res = await send("/api/session", "POST", { username, code });
    Identity.save({ username: res.username, token: res.token, access: res.access });
    return { username: res.username, log: res.log, access: res.access };
  }

  /**
   * Re-read the AI access tier. Cheap, and worth doing on load: a cap
   * raised or a code revoked since the last sign-in should show up
   * without making anyone sign out and back in to find out.
   */
  async function refreshAccess() {
    if (!Identity.isSignedIn()) {
      return null;
    }
    try {
      const res = await send("/api/access", "GET");
      Identity.setAccess(res.access);
      return res.access;
    } catch (err) {
      if (err.status === 401) {
        Identity.clear();
      }
      return null;
    }
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

  /**
   * Mint an invite code. Resolves to { code, cap_usd, ... } or throws
   * with a sentence worth showing.
   *
   * `adminToken` is passed in on every call and never stored — not in
   * Identity, not in localStorage, not in a module variable. It is the
   * one credential here that grants the ability to spend money on
   * someone else's behalf, and the cost of keeping it is a retype.
   *
   * The 404 translation matters. The Worker answers 404 rather than 401
   * for a bad or missing admin token, on purpose: an admin route that
   * says "wrong password" has confirmed it exists. That is right for the
   * wire and useless on screen, so the one caller who was definitely
   * aiming at the route says what a 404 means for them.
   */
  async function mintCode(adminToken, capUsd) {
    const label = `minted ${new Date().toISOString().slice(0, 10)}`;
    try {
      const res = await send(
        "/api/admin/codes",
        "POST",
        { cap_usd: capUsd, label },
        { "x-admin-token": adminToken }
      );
      return res.code;
    } catch (err) {
      if (err.status === 404) {
        throw new Error("That admin token wasn't accepted. No code was created.");
      }
      throw err;
    }
  }

  /**
   * Switch an invite code off. Resolves to { code, wasActive }.
   *
   * Takes effect on the next turn, not the next sign-in: the Worker
   * re-reads the code on every `/api/coach` call, so a session already
   * open loses AI coaching mid-conversation rather than keeping it until
   * the tab is closed.
   *
   * Two 404s are possible here and they mean opposite things — a token
   * that wasn't accepted, and a token that was accepted for a code that
   * doesn't exist. The `reason` field is what separates them; a bad
   * token never carries one, so it cannot be used to probe for codes.
   */
  async function revokeCode(adminToken, code) {
    try {
      const res = await send(
        `/api/admin/codes/${encodeURIComponent(code)}`,
        "PATCH",
        { active: false },
        { "x-admin-token": adminToken }
      );
      return { code: res.code, wasActive: res.was_active };
    } catch (err) {
      if (err.reason === "unknown_code") {
        throw new Error("No invite code by that name. Check the spelling — nothing was changed.");
      }
      if (err.status === 404) {
        throw new Error("That admin token wasn't accepted. Nothing was changed.");
      }
      throw err;
    }
  }

  async function send(path, method, body, extraHeaders) {
    const headers = { "content-type": "application/json", ...extraHeaders };
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
      // Present only where the server needed a caller to branch on
      // something finer than the status code. Usually undefined.
      err.reason = data.reason;
      throw err;
    }
    return data;
  }

  return { signIn, refreshAccess, mintCode, revokeCode, pullLog, pushLog, clearLog };
})();
