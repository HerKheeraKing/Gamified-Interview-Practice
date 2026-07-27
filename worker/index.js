/**
 * worker/index.js
 * ------------------------------------------------------------
 * Cloudflare Worker for The Interview Case Files.
 *
 * Structure (mirrors assets/js/app.js — layers, not files):
 *   1. Responses    - JSON/error helpers, no domain knowledge
 *   2. Credentials  - the one place that decides "is this login valid"
 *   3. Detectives   - account rows + session tokens
 *   4. CaseLog      - XP entries, read and merge
 *   5. Router       - maps requests to the layers above
 *
 * Everything that isn't /api/* falls through to the static assets
 * binding, so the Worker serves the whole site from one deployment.
 *
 * Passwords: the site is username-only today. Credentials is the single
 * seam where that changes — swap the body of `verify` and `register`
 * and no other layer moves.
 * ------------------------------------------------------------
 */

const API_PREFIX = "/api/";
const MAX_USERNAME = 32;
const MAX_PUSH_ENTRIES = 500;

/* ---------------------------------------------------------- */
/* 1. RESPONSES                                                */
/* ---------------------------------------------------------- */

const Responses = (() => {
  const HEADERS = { "content-type": "application/json; charset=utf-8" };

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: HEADERS });
  }

  function fail(message, status = 400) {
    return json({ error: message }, status);
  }

  return { json, fail };
})();

/* ---------------------------------------------------------- */
/* 2. CREDENTIALS                                              */
/* ---------------------------------------------------------- */

/**
 * Owns the answer to "may this request become a session for this row?".
 *
 * Today every account is passwordless: password_hash is NULL and any
 * login attempt for an existing name succeeds. When passwords arrive,
 * `verify` starts rejecting rows that carry a hash unless the supplied
 * password matches, and `register` starts filling hash + salt in. The
 * hashing helpers below are already correct PBKDF2 — they're simply
 * unused until a password is actually supplied.
 */
const Credentials = (() => {
  const ITERATIONS = 100000;

  async function hash(password, saltHex) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: ITERATIONS },
      key,
      256
    );
    return toHex(new Uint8Array(bits));
  }

  /** Credential fields for a brand new account. */
  async function register(password) {
    if (!password) {
      return { password_hash: null, password_salt: null };
    }
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    return { password_hash: await hash(password, salt), password_salt: salt };
  }

  /** True when `password` (possibly absent) satisfies an existing row. */
  async function verify(detective, password) {
    if (!detective.password_hash) {
      return true;
    }
    if (!password) {
      return false;
    }
    const candidate = await hash(password, detective.password_salt);
    return timingSafeEqual(candidate, detective.password_hash);
  }

  function toHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function fromHex(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function timingSafeEqual(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  return { register, verify };
})();

/* ---------------------------------------------------------- */
/* 3. DETECTIVES                                               */
/* ---------------------------------------------------------- */

const Detectives = (() => {
  /**
   * Log in, creating the account on first sight.
   * Returns { token, username } or null when credentials are rejected.
   */
  async function openSession(db, username, password) {
    const name = normalise(username);
    if (!name) {
      return null;
    }

    const now = new Date().toISOString();
    let detective = await db
      .prepare("SELECT * FROM detectives WHERE username = ?")
      .bind(name)
      .first();

    if (detective) {
      if (!(await Credentials.verify(detective, password))) {
        return null;
      }
      await db
        .prepare("UPDATE detectives SET last_seen_at = ? WHERE id = ?")
        .bind(now, detective.id)
        .run();
    } else {
      const creds = await Credentials.register(password);
      const created = await db
        .prepare(
          `INSERT INTO detectives (username, password_hash, password_salt, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?) RETURNING *`
        )
        .bind(name, creds.password_hash, creds.password_salt, now, now)
        .first();
      detective = created;
    }

    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    await db
      .prepare("INSERT INTO sessions (token, detective_id, created_at) VALUES (?, ?, ?)")
      .bind(token, detective.id, now)
      .run();

    return { token, id: detective.id, username: detective.username };
  }

  /** Resolve a bearer token to a detective id, or null. */
  async function fromRequest(db, request) {
    const header = request.headers.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return null;
    }

    const row = await db
      .prepare(
        `SELECT d.id, d.username FROM sessions s
         JOIN detectives d ON d.id = s.detective_id
         WHERE s.token = ?`
      )
      .bind(token)
      .first();

    return row || null;
  }

  /** Trim, collapse whitespace, cap length. Empty result means invalid. */
  function normalise(username) {
    if (typeof username !== "string") {
      return "";
    }
    return username.trim().replace(/\s+/g, " ").slice(0, MAX_USERNAME);
  }

  return { openSession, fromRequest };
})();

/* ---------------------------------------------------------- */
/* 4. CASE LOG                                                 */
/* ---------------------------------------------------------- */

const CaseLog = (() => {
  /** The full log, oldest first — the same shape the client stores. */
  async function read(db, detectiveId) {
    const result = await db
      .prepare(
        `SELECT entry_uid, case_id, question_short, date_label, logged_at, raw_score, bonus, xp
         FROM case_log WHERE detective_id = ? ORDER BY logged_at ASC, id ASC`
      )
      .bind(detectiveId)
      .all();

    return (result.results || []).map(toEntry);
  }

  /**
   * Merge client entries in, then hand back the authoritative log.
   * Entries already present (same entry_uid) are left untouched, so
   * this is safe to call with the client's entire history every time.
   */
  async function merge(db, detectiveId, entries) {
    const clean = entries.filter(isValid).slice(0, MAX_PUSH_ENTRIES);

    if (clean.length > 0) {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO case_log
           (detective_id, entry_uid, case_id, question_short, date_label, logged_at, raw_score, bonus, xp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      await db.batch(
        clean.map((e) =>
          insert.bind(
            detectiveId,
            e.uid,
            e.caseId,
            String(e.questionShort).slice(0, 120),
            String(e.date).slice(0, 40),
            e.loggedAt,
            e.rawScore,
            e.bonus ? 1 : 0,
            e.xp
          )
        )
      );
    }

    return read(db, detectiveId);
  }

  async function clear(db, detectiveId) {
    await db.prepare("DELETE FROM case_log WHERE detective_id = ?").bind(detectiveId).run();
  }

  function toEntry(row) {
    return {
      uid: row.entry_uid,
      caseId: row.case_id,
      questionShort: row.question_short,
      date: row.date_label,
      loggedAt: row.logged_at,
      rawScore: row.raw_score,
      bonus: row.bonus === 1,
      xp: row.xp,
    };
  }

  function isValid(entry) {
    return (
      entry &&
      typeof entry.uid === "string" &&
      entry.uid.length > 0 &&
      Number.isFinite(entry.caseId) &&
      Number.isFinite(entry.rawScore) &&
      Number.isFinite(entry.xp) &&
      typeof entry.loggedAt === "string"
    );
  }

  return { read, merge, clear };
})();

/* ---------------------------------------------------------- */
/* 5. ROUTER                                                   */
/* ---------------------------------------------------------- */

async function handleApi(request, env, path) {
  if (path === "/api/session" && request.method === "POST") {
    const body = await readJson(request);
    const session = await Detectives.openSession(env.DB, body.username, body.password);
    if (!session) {
      return Responses.fail("Those credentials didn't check out.", 401);
    }
    return Responses.json({
      token: session.token,
      username: session.username,
      log: await CaseLog.read(env.DB, session.id),
    });
  }

  // Everything past this point needs a session.
  const detective = await Detectives.fromRequest(env.DB, request);
  if (!detective) {
    return Responses.fail("Not signed in.", 401);
  }

  if (path === "/api/log" && request.method === "GET") {
    return Responses.json({ log: await CaseLog.read(env.DB, detective.id) });
  }

  if (path === "/api/log" && request.method === "POST") {
    const body = await readJson(request);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    return Responses.json({ log: await CaseLog.merge(env.DB, detective.id, entries) });
  }

  if (path === "/api/log" && request.method === "DELETE") {
    await CaseLog.clear(env.DB, detective.id);
    return Responses.json({ log: [] });
  }

  return Responses.fail("No such case file.", 404);
}

async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch (err) {
    return {};
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    if (!path.startsWith(API_PREFIX)) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApi(request, env, path);
    } catch (err) {
      console.error("API failure:", err);
      return Responses.fail("The case files are unreachable right now.", 500);
    }
  },
};
