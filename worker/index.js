/**
 * worker/index.js
 * ------------------------------------------------------------
 * Cloudflare Worker for The Interview Case Files.
 *
 * Structure (mirrors assets/js/app.js — layers, not files):
 *   1. Responses    - JSON/error helpers, no domain knowledge
 *   2. Credentials  - the one place that decides "is this login valid"
 *   3. Access       - who may spend money on AI coaching, and how much
 *   4. Detectives   - account rows + session tokens
 *   5. CaseLog      - XP entries, read and merge
 *   5b. Drafts      - unfinished practice sessions, saved to resume
 *   6. Pricing      - Anthropic token counts -> US dollars
 *   7. Coach        - the only place that holds the Anthropic API key
 *   8. Admin        - mint invite codes, read and adjust their caps
 *   9. Health       - is this deployment wired up? (bindings, schema)
 *  10. Router       - maps requests to the layers above
 *
 * Everything that isn't /api/* falls through to the static assets
 * binding, so the Worker serves the whole site from one deployment.
 *
 * Passwords: the site is username-only today. Credentials is the single
 * seam where that changes — swap the body of `verify` and `register`
 * and no other layer moves.
 *
 * Money: /api/coach is the only route that costs anything, and Access is
 * the only module that decides whether a given caller may trigger it.
 * Every other layer is deliberately ignorant of tiers — the scorecard,
 * the XP log and the sync path behave identically for a beta tester and
 * a stranger, because none of them touch the API.
 * ------------------------------------------------------------
 */

const API_PREFIX = "/api/";
const MAX_USERNAME = 32;
const MAX_PUSH_ENTRIES = 500;

// A saved draft is one practice session, so it is bounded by what one
// session can plausibly be. MAX_DRAFT_TURNS sits above Coach's own
// MAX_TURNS (24) because a draft records everything that was said,
// including the turns Coach itself would have trimmed off the front of
// the next request. MAX_DRAFT_CHARS matches Coach's MAX_CHARS: content
// longer than that is already truncated before the model ever sees it,
// so storing more would preserve text that can no longer affect a reply.
const MAX_DRAFT_TURNS = 40;
const MAX_DRAFT_CHARS = 4000;

/* ---------------------------------------------------------- */
/* 1. RESPONSES                                                */
/* ---------------------------------------------------------- */

const Responses = (() => {
  const HEADERS = { "content-type": "application/json; charset=utf-8" };

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: HEADERS });
  }

  /**
   * An error the client can show, and optionally one it can branch on.
   *
   * `reason` exists for the single case where two different failures
   * legitimately share a status code and the caller has to tell them
   * apart — see the admin routes, where a bad token and an unknown
   * invite code are both 404 on purpose. Branching on the prose instead
   * would make every error message load-bearing.
   */
  function fail(message, status = 400, reason) {
    const body = { error: message };
    if (reason) {
      body.reason = reason;
    }
    return json(body, status);
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

  return { register, verify, constantTimeEqual: timingSafeEqual };
})();

/* ---------------------------------------------------------- */
/* 3. ACCESS                                                   */
/* ---------------------------------------------------------- */

/**
 * The answer to "may this account spend my Anthropic credit, and how
 * much is left?".
 *
 * Three tiers, and the important thing about them is what they have in
 * common: the site works in all three. Manual scoring, the XP log, the
 * streak, sync, and Send to Claude are free of API cost and therefore
 * free of gatekeeping. Only Text Practice and Live Voice — the two paths
 * that reach api.anthropic.com — are tiered.
 *
 *   owner    "kheera", proven by OWNER_PASSPHRASE. No cap.
 *   invited  redeemed an invite code. Capped at that code's cap_usd,
 *            measured in real dollars.
 *   free     everyone else. No AI coaching, no /api/coach call made.
 *
 * Why the owner needs a passphrase at all: the username field is free
 * text and creates an account for whatever is typed into it. Without a
 * secret, "kheera" is not an identity, it is a nine-keystroke bypass of
 * the entire cap system. The passphrase is checked before the row is
 * looked up or created, so the name cannot even be squatted.
 *
 * Failing closed is deliberate throughout. An unset OWNER_PASSPHRASE
 * makes the owner name unusable rather than unguarded, and an unset
 * ADMIN_TOKEN (see Admin) makes the admin routes 404 rather than open.
 * The failure mode of a missing secret should be "I can't get in",
 * never "anyone can".
 */
const Access = (() => {
  const OWNER = "kheera";
  const CODE_LENGTH = 24;

  /* ---- who is this? ---- */

  /** True when `username` claims the owner account, whoever typed it. */
  function claimsOwner(env, username) {
    return normaliseName(username) === ownerName(env);
  }

  /**
   * True when `secret` proves the owner claim.
   *
   * Constant-time, and false when the deployment has no passphrase set —
   * an empty configured value must never be satisfiable by an empty
   * submitted one.
   */
  function provesOwner(env, secret) {
    const expected = env.OWNER_PASSPHRASE || "";
    if (!expected || typeof secret !== "string" || !secret) {
      return false;
    }
    return Credentials.constantTimeEqual(secret, expected);
  }

  /**
   * The tier this detective is currently in, with the numbers behind it.
   *
   * Read fresh from D1 on every call rather than cached on the session:
   * a cap raised or a code revoked has to take effect on the next turn,
   * not on the next sign-in, and a session token can outlive both.
   */
  async function summary(db, env, detective) {
    if (isOwner(env, detective)) {
      return { tier: "owner", ai: true };
    }

    const code = detective.access_code ? await find(db, detective.access_code) : null;
    if (!code || code.active !== 1) {
      // A revoked or deleted code degrades to free rather than erroring.
      // The detective keeps their case files and their XP; they lose the
      // two AI modes and are told why, which is the whole difference.
      return { tier: "free", ai: false };
    }

    const remaining = Math.max(0, code.cap_usd - code.spent_usd);
    return {
      tier: "invited",
      ai: remaining > 0,
      code: code.code,
      cap: round(code.cap_usd),
      spent: round(code.spent_usd),
      remaining: round(remaining),
      turns: code.turns,
    };
  }

  /** Owner-ness is derived from the name, because only the passphrase grants it. */
  function isOwner(env, detective) {
    return normaliseName(detective.username) === ownerName(env);
  }

  /* ---- invite codes ---- */

  async function find(db, code) {
    const clean = normaliseCode(code);
    if (!clean) {
      return null;
    }
    return db.prepare("SELECT * FROM invite_codes WHERE code = ?").bind(clean).first();
  }

  /**
   * Charge `amount` against a code, but only if it is live and under cap.
   *
   * One statement, on purpose. Reading the balance and then writing it
   * would leave a window between the two, and that window is precisely
   * what a burst of parallel requests exploits — twenty callers each read
   * $0.49 of a $0.50 cap, each conclude they are under it, and each spend.
   * SQLite applies the WHERE and the SET together, so exactly one of the
   * twenty can be the one that crosses the line.
   *
   * Returns true when the charge landed.
   */
  async function charge(db, code, amount) {
    const result = await db
      .prepare(
        `UPDATE invite_codes
            SET spent_usd = spent_usd + ?, turns = turns + 1, last_used_at = ?
          WHERE code = ? AND active = 1 AND spent_usd < cap_usd`
      )
      .bind(amount, new Date().toISOString(), normaliseCode(code))
      .run();

    return (result.meta && result.meta.changes) === 1;
  }

  /**
   * Replace a provisional charge with what the turn actually cost.
   *
   * Charging happens before the request and settling after it, because
   * the true cost is not knowable until the model has stopped talking —
   * a two-sentence reply and a rambling one bill differently, which is
   * the entire reason this is metered in dollars rather than requests.
   *
   * The gap between the two is where this fails safe: if the Worker dies
   * mid-stream or the browser walks away, the provisional charge simply
   * stands. A code can be over-billed by one turn's worst case. It can
   * never be under-billed, and it can never be silently un-billed.
   */
  async function settle(db, code, provisional, actual) {
    await db
      .prepare(
        `UPDATE invite_codes
            SET spent_usd = MAX(0, spent_usd - ? + ?)
          WHERE code = ?`
      )
      .bind(provisional, actual, normaliseCode(code))
      .run();
  }

  /** Refund a provisional charge in full — the turn never happened. */
  async function refund(db, code, provisional) {
    await settle(db, code, provisional, 0);
  }

  /**
   * A fresh code: CASE-XXXX-XXXX-XXXX.
   *
   * The alphabet drops I, L, O, 0 and 1. These get read aloud, typed off
   * a screenshot, and retyped from memory, and every one of those steps
   * is where an O becomes a zero. Thirty-one characters over twelve
   * positions is still far past guessable.
   */
  function mint() {
    const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const body = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
    return `CASE-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
  }

  function normaliseCode(code) {
    if (typeof code !== "string") {
      return "";
    }
    return code.trim().toUpperCase().slice(0, CODE_LENGTH);
  }

  function normaliseName(username) {
    return typeof username === "string" ? username.trim().toLowerCase() : "";
  }

  function ownerName(env) {
    return normaliseName(env.OWNER_USERNAME || OWNER);
  }

  /** Dollars, to the tenth of a cent — below that nothing here is meaningful. */
  function round(usd) {
    return Math.round(usd * 10000) / 10000;
  }

  return {
    claimsOwner,
    provesOwner,
    summary,
    find,
    charge,
    settle,
    refund,
    mint,
    normaliseCode,
    round,
  };
})();

/* ---------------------------------------------------------- */
/* 4. DETECTIVES                                               */
/* ---------------------------------------------------------- */

const Detectives = (() => {
  /**
   * Log in, creating the account on first sight.
   *
   * `secret` is the one optional field beside the codename, and it means
   * whichever of two things the codename implies: the owner passphrase
   * when the name is the owner's, an invite code otherwise. One field,
   * because the detective typing it does not need to know there are two
   * mechanisms — they were handed a string and told it unlocks coaching.
   *
   * Returns { token, id, username } or { error } with a sentence worth
   * showing. Rejections are specific here rather than a blanket "those
   * credentials didn't check out": a mistyped invite code and a wrong
   * passphrase are different mistakes with different fixes, and the
   * information leaked by saying so is information the person already
   * had when they typed it.
   */
  async function openSession(db, env, username, secret) {
    const name = normalise(username);
    if (!name) {
      return { error: "Every detective needs a name." };
    }

    // Before the row is read or written, because the owner name must not
    // be claimable — not even as an empty free-tier account that squats
    // the codename and locks the real owner out of their own log.
    let redeemed = null;
    if (Access.claimsOwner(env, name)) {
      if (!Access.provesOwner(env, secret)) {
        return { error: "That codename is taken. It needs its passphrase." };
      }
    } else if (secret) {
      const code = await Access.find(db, secret);
      if (!code || code.active !== 1) {
        return { error: "That access code isn't on file. Leave it blank to practise without AI coaching." };
      }
      redeemed = code.code;
    }

    const now = new Date().toISOString();
    let detective = await db
      .prepare("SELECT * FROM detectives WHERE username = ?")
      .bind(name)
      .first();

    if (detective) {
      if (!(await Credentials.verify(detective, null))) {
        return { error: "Those credentials didn't check out." };
      }
      // A code only ever overwrites when one was actually supplied, so
      // signing in from a second device without retyping it does not
      // silently demote the account to free.
      await db
        .prepare(
          `UPDATE detectives
              SET last_seen_at = ?, access_code = COALESCE(?, access_code)
            WHERE id = ?`
        )
        .bind(now, redeemed, detective.id)
        .run();
      detective.access_code = redeemed || detective.access_code;
    } else {
      const creds = await Credentials.register(null);
      detective = await db
        .prepare(
          `INSERT INTO detectives
             (username, password_hash, password_salt, created_at, last_seen_at, access_code)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
        )
        .bind(name, creds.password_hash, creds.password_salt, now, now, redeemed)
        .first();
    }

    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    await db
      .prepare("INSERT INTO sessions (token, detective_id, created_at) VALUES (?, ?, ?)")
      .bind(token, detective.id, now)
      .run();

    return { token, id: detective.id, username: detective.username, access_code: detective.access_code };
  }

  /** Resolve a bearer token to a detective row, or null. */
  async function fromRequest(db, request) {
    const header = request.headers.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return null;
    }

    const row = await db
      .prepare(
        `SELECT d.id, d.username, d.access_code FROM sessions s
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
/* 5b. DRAFTS                                                  */
/* ---------------------------------------------------------- */

/**
 * A practice session that was left rather than finished.
 *
 * The neighbouring module is the one to compare this against. CaseLog
 * stores what a case was worth; this stores what was said while working
 * it. They are deliberately unaware of each other — saving a draft
 * writes no XP, reading one grants none, and deleting every row in this
 * table would cost a detective nothing but their place in a
 * conversation. That separation is the feature: a resume point must
 * never be able to inflate a score, and a scored attempt must never be
 * blocked by a draft that happens to exist.
 *
 * One row per detective per case, enforced by the primary key. `save`
 * is an UPSERT, so saving twice overwrites rather than accumulating —
 * which is why nothing here needs a draft id, a list-per-case, or a
 * rule about which of several drafts is the current one.
 *
 * The transcript is stored and returned as opaque JSON. This module
 * checks its shape — an array of { role, content } within bounds — and
 * then declines to look inside it. The browser owns what a turn means.
 */
const Drafts = (() => {
  const MODES = ["text", "voice"];

  /**
   * Every case with a draft, without the transcripts.
   *
   * The case grid needs to know *which* cases have something saved, and
   * nothing more; sending forty turns per case to draw a badge would be
   * the whole feature's data over the wire to render a word.
   */
  async function list(db, detectiveId) {
    const result = await db
      .prepare(
        `SELECT case_id, mode, updated_at FROM session_drafts
         WHERE detective_id = ? ORDER BY updated_at DESC`
      )
      .bind(detectiveId)
      .all();

    return (result.results || []).map((row) => ({
      caseId: row.case_id,
      mode: row.mode,
      updatedAt: row.updated_at,
    }));
  }

  /** One draft in full, or null. */
  async function read(db, detectiveId, caseId) {
    const row = await db
      .prepare(
        `SELECT case_id, mode, transcript, updated_at FROM session_drafts
         WHERE detective_id = ? AND case_id = ?`
      )
      .bind(detectiveId, caseId)
      .first();

    if (!row) {
      return null;
    }

    return {
      caseId: row.case_id,
      mode: row.mode,
      messages: parse(row.transcript),
      updatedAt: row.updated_at,
    };
  }

  /**
   * Write the draft for one case, replacing whatever was there.
   *
   * Returns the stored draft, or null when the request didn't describe
   * one. Rejecting rather than silently storing a repaired version is
   * the right call here even though this is a resume point and not
   * money: a draft that comes back subtly different from what was sent
   * would surface as a conversation that lost a turn, and the only
   * place that could be diagnosed is the one place nobody looks.
   */
  async function save(db, detectiveId, caseId, mode, messages) {
    if (!MODES.includes(mode) || !Number.isInteger(caseId) || !Array.isArray(messages)) {
      return null;
    }

    const clean = messages.filter(isTurn).slice(-MAX_DRAFT_TURNS).map(toTurn);
    if (clean.length === 0) {
      return null;
    }

    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO session_drafts (detective_id, case_id, mode, transcript, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (detective_id, case_id)
         DO UPDATE SET mode = excluded.mode,
                       transcript = excluded.transcript,
                       updated_at = excluded.updated_at`
      )
      .bind(detectiveId, caseId, mode, JSON.stringify(clean), now)
      .run();

    return { caseId, mode, messages: clean, updatedAt: now };
  }

  /** Drop the draft for one case. Silent when there wasn't one. */
  async function remove(db, detectiveId, caseId) {
    await db
      .prepare("DELETE FROM session_drafts WHERE detective_id = ? AND case_id = ?")
      .bind(detectiveId, caseId)
      .run();
  }

  function isTurn(turn) {
    return (
      turn &&
      (turn.role === "user" || turn.role === "assistant") &&
      typeof turn.content === "string" &&
      turn.content.trim().length > 0
    );
  }

  function toTurn(turn) {
    return { role: turn.role, content: turn.content.slice(0, MAX_DRAFT_CHARS) };
  }

  /**
   * Read a stored transcript back.
   *
   * Empty rather than throwing on a row that won't parse. Everything
   * written here went through `save`, so this should be impossible —
   * and if it ever isn't, one unreadable draft should cost that case
   * its resume point, not take the case grid down with it.
   */
  function parse(transcript) {
    try {
      const messages = JSON.parse(transcript);
      return Array.isArray(messages) ? messages.filter(isTurn) : [];
    } catch (err) {
      console.error("Unreadable draft transcript:", err && err.message);
      return [];
    }
  }

  return { list, read, save, remove };
})();

/* ---------------------------------------------------------- */
/* 6. PRICING                                                  */
/* ---------------------------------------------------------- */

/**
 * Token counts in, US dollars out.
 *
 * A spend cap has to be denominated in the thing that actually gets
 * billed. Counting requests would have been a line of code, and it would
 * have been wrong in both directions: a clarifying question that costs a
 * twentieth of a cent and a full coached answer with a long transcript
 * behind it are one request each and differ by an order of magnitude.
 *
 * Four token classes, four rates, because prompt caching is on. The
 * cached instruction block is roughly 1,500 tokens that would otherwise
 * be charged at full input price on every single turn; read from cache
 * it is a tenth of that. Pricing cache reads as fresh input would have
 * the cap fire an order of magnitude early on exactly the deployment
 * that is being careful with money.
 *
 * Rates are USD per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing (checked
 * 2026-07-28). They are duplicated here rather than fetched because a
 * pricing lookup on the request path would be a second thing that can
 * fail while someone is mid-interview. The cost of that choice is that
 * this table goes stale silently, so UNKNOWN below exists to make the
 * staleness expensive in the safe direction rather than the cheap one.
 */
const Pricing = (() => {
  const PER_MTOK = {
    "claude-sonnet-5": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
    "claude-opus-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
    "claude-haiku-4-5-20251001": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
    "claude-sonnet-4-5": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  };

  // What an unrecognised model costs. Deliberately the most expensive row
  // in the table above: someone setting COACH_MODEL to something new
  // should over-spend their cap slightly, not blow through it silently.
  const UNKNOWN = PER_MTOK["claude-opus-5"];

  // Sonnet 5 runs at introductory $2/$10 through 2026-08-31 and $3/$15
  // from 2026-09-01. The table holds the higher, permanent numbers on
  // purpose. Encoding the discount would mean the cap changes meaning on
  // a date nobody is watching for, and being billed less than the meter
  // said is the direction of surprise worth having.

  /** USD for one turn. `usage` is whatever Coach counted off the stream. */
  function costOf(model, usage) {
    const rate = PER_MTOK[model] || UNKNOWN;
    return (
      (usage.input * rate.input +
        usage.cacheWrite * rate.cacheWrite +
        usage.cacheRead * rate.cacheRead +
        usage.output * rate.output) /
      1e6
    );
  }

  /**
   * The most *this particular turn* could cost, charged up front and
   * refunded down to the real figure once the turn is over.
   *
   * Sized to the transcript actually being sent rather than to the
   * MAX_TURNS × MAX_CHARS limit, and that distinction is the difference
   * between a workable hold and a punitive one. The theoretical worst
   * case is around ten times a real turn, so holding it would mean a
   * $0.50 code could only ever have five turns in flight, and a browser
   * closed mid-answer — where the settle never runs — would forfeit ten
   * turns' worth of budget for one.
   *
   * Every term here is still an upper bound, so the hold can only ever
   * be refunded downward:
   *   input   the transcript at the conventional four characters per
   *           token, plus the instruction block, rounded up by treating
   *           it as uncached
   *   output  MAX_TOKENS, which the request itself enforces
   */
  function ceiling(model, { chars, systemTokens, maxTokens }) {
    return costOf(model, {
      input: chars / 4 + systemTokens,
      cacheWrite: systemTokens,
      cacheRead: 0,
      output: maxTokens,
    });
  }

  return { costOf, ceiling };
})();

/* ---------------------------------------------------------- */
/* 7. COACH                                                    */
/* ---------------------------------------------------------- */

/**
 * The interviewer. Owns the Anthropic API key and everything about
 * Anthropic's wire format.
 *
 * The browser never sees either. It POSTs { question, messages } and
 * reads back a stream of two event shapes and nothing else:
 *
 *   data: {"text": "..."}      a chunk of coaching prose, in order
 *   data: {"done": true}       the turn is finished
 *
 * That narrow contract is the whole point. Swapping models, changing
 * the system prompt, or moving to a different provider entirely never
 * reaches the client, and no request path exists that could leak the
 * key back out — it is read here and nowhere else in the codebase.
 *
 * Scores ride inside the prose rather than arriving as tool use, so a
 * single stream can be spoken aloud the instant it starts. The model
 * writes its coaching, then a final SCORE_MARKER line holding JSON.
 * The client speaks everything before the marker and parses what
 * follows. Tool use would have forced the client to wait for a
 * complete JSON block before it could say a word.
 */
const Coach = (() => {
  const ENDPOINT = "https://api.anthropic.com/v1/messages";
  const API_VERSION = "2023-06-01";
  const DEFAULT_MODEL = "claude-sonnet-5";
  const MAX_TOKENS = 1024;
  const MAX_TURNS = 24;
  const MAX_CHARS = 4000;

  // The INTERVIEWER block below, in tokens. Only used to price the worst
  // case up front, so it is rounded generously upward — it must not
  // under-state the ceiling. It is also the number that has to stay above
  // 1,024 for the prompt cache to engage at all; see systemPrompt.
  const SYSTEM_TOKENS = 1800;

  // The five score keys — structure, relevance, clarity, evidence and
  // impact — are written out inside INTERVIEWER below, both in the line
  // the model must end on and in the anchors that say what each number
  // means. They must match the `key` values in
  // public/assets/js/questions.js. The client ignores any key it
  // doesn't recognise, so adding a category on one side and not the
  // other degrades quietly.
  const SCORE_MARKER = "[[SCORES]]";

  /** Which model this deployment is talking to. */
  function model(env) {
    return env.COACH_MODEL || DEFAULT_MODEL;
  }

  /**
   * The most this turn could cost, in USD, given what is being sent.
   *
   * Measured on the trimmed messages rather than the raw ones so the
   * number matches the request that will actually go out — trim drops
   * everything past MAX_TURNS and truncates at MAX_CHARS, and a hold
   * priced on text that gets discarded is a hold on nothing.
   */
  function estimate(env, question, messages) {
    const chars = trim(messages).reduce((total, m) => total + m.content.length, 0) + question.length;
    return Pricing.ceiling(model(env), {
      chars,
      systemTokens: SYSTEM_TOKENS,
      maxTokens: MAX_TOKENS,
    });
  }

  /**
   * Run one interviewer turn. Resolves to a Response carrying the
   * simplified event stream described above.
   *
   * `onSpend(usd)` is called once, after the last token, with what the
   * turn actually cost. It is optional — the owner's turns are not
   * metered — and it is called from inside the stream rather than here
   * because the cost of a turn is not known until the turn is over.
   * Callers who need the write to outlive the response must hand it to
   * ctx.waitUntil themselves; see the /api/coach route.
   */
  async function converse(env, question, messages, onSpend) {
    if (!env.ANTHROPIC_API_KEY) {
      return Responses.fail("AI practice isn't configured on this deployment.", 503);
    }

    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": API_VERSION,
        "x-api-key": env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: model(env),
        max_tokens: MAX_TOKENS,
        stream: true,
        system: systemPrompt(question),
        messages: trim(messages),
      }),
    });

    if (!upstream.ok) {
      console.error("Anthropic rejected the turn:", upstream.status, await upstream.text());
      return Responses.fail("The interviewer is unavailable right now.", 502);
    }

    return new Response(upstream.body.pipeThrough(simplify(env, onSpend)), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  /**
   * The system prompt, as two blocks.
   *
   * The first is every word that doesn't depend on which case is being
   * worked, and it is the one marked for caching. The second is the
   * question, which changes, and is deliberately left out of the cached
   * prefix — a cache entry is keyed on everything up to and including
   * the marked block, so folding the question in would mint a separate
   * entry per question and share nothing between them. Split this way,
   * one entry is reused by every turn of every session on the whole
   * deployment.
   *
   * Order matters and is not stylistic: the cached block has to come
   * first, because the prefix is hashed in order.
   */
  function systemPrompt(question) {
    return [
      { type: "text", text: INTERVIEWER, cache_control: { type: "ephemeral" } },
      { type: "text", text: `The question on the table is: "${question}"` },
    ];
  }

  /**
   * The interviewer's standing instructions. Identical on every call, by
   * design — see systemPrompt.
   *
   * It is long, and deliberately so: below 1,024 tokens Sonnet won't
   * cache a prefix at all, and a prompt that just misses the threshold
   * is the worst of both worlds. The length is spent on scoring anchors
   * rather than padding, because the thing worth buying with those
   * tokens is calibration. "Score honestly" alone left 3 doing far too
   * much work; saying what each number actually looks like is what
   * makes two runs of the same answer land on the same number.
   */
  const INTERVIEWER = [
    "You are a warm but exacting technical interviewer running a mock interview.",
    "The candidate is practising for cloud engineering roles built on AWS and",
    "Python. They are answering the question below and nothing else.",
    "",
    "BREVITY — THIS MATTERS MORE THAN ANY OTHER INSTRUCTION HERE.",
    "Your coaching is usually read aloud to the candidate by a synthetic voice",
    "while they wait to speak again. Every extra sentence is dead air. Be short",
    "and land the point:",
    "- Two to four sentences of coaching. Never five. Often two is right.",
    "- One follow-up question, one sentence long.",
    "- No preamble. Do not restate their answer back to them, do not open with",
    "  'Great question' or 'Thanks for sharing' or 'That's a solid start' as a",
    "  throat-clear before the real feedback. Begin with the feedback.",
    "- No summary at the end. No 'in short', no 'overall'. Stop when done.",
    "- One idea per sentence. Prefer plain words over hedged ones.",
    "- Say the most valuable thing first, in case they stop listening.",
    "",
    "Every time the candidate answers, reply in this order:",
    "1. Two to four sentences of specific coaching. Name what actually worked and",
    "   the single highest-value thing to change — one thing, the biggest one,",
    "   not a list of everything you noticed. Quote their own words back when it",
    "   sharpens the point. No generic praise, no bullet lists, no headings.",
    "2. One short follow-up question a real interviewer would ask next. It should",
    "   press on the weakest part of what they just said.",
    "3. On its own final line, exactly this and nothing after it:",
    `   ${SCORE_MARKER}{"structure":N,"relevance":N,"clarity":N,"evidence":N,"impact":N}`,
    "",
    "Each N is an integer from 1 to 5. Score the answer you were just given, not",
    "the candidate's potential and not the conversation so far. Use the whole",
    "range: most real answers in practice are 2s and 3s, a 5 is genuinely rare,",
    "and inflating scores robs the candidate of the only signal they came for.",
    "",
    "STRUCTURE — a clear STAR-style frame rather than a ramble.",
    "1: no shape at all; facts in the order they occurred to them.",
    "2: a situation and an action, no task framing and no result.",
    "3: recognisable STAR with one weak limb, usually a thin result.",
    "4: all four parts present and in proportion, no wasted setup.",
    "5: all four, plus the pacing to spend longest on the action and land the",
    "   result in a sentence.",
    "",
    "RELEVANCE — actually answers the question that was asked.",
    "1: answers a different question, or a rehearsed story bolted on.",
    "2: touches the question but spends most of the time elsewhere.",
    "3: answers it, with a detour that costs them time.",
    "4: answers exactly what was asked, nothing extraneous.",
    "5: answers it and anticipates the obvious follow-up without being asked.",
    "",
    "CLARITY — concise, confident delivery with little filler.",
    "1: hard to follow; restarts, contradictions, trailing sentences.",
    "2: followable but padded, hedged, or circling the same point.",
    "3: clear enough, some filler and a slow start.",
    "4: tight and easy to follow start to finish.",
    "5: tight, and explains a technical idea in terms that would survive being",
    "   repeated to a non-specialist.",
    "",
    "EVIDENCE — specific details: named services, tools, numbers, outcomes.",
    "1: entirely abstract; could be said by someone who has never done it.",
    "2: names a technology but nothing about how it was used.",
    "3: real specifics in one part of the answer, vague in the rest.",
    "4: concrete throughout — services named, decisions explained, numbers where",
    "   numbers exist.",
    "5: concrete throughout, and the specifics show judgement: why this service",
    "   rather than the obvious alternative, what the trade-off cost.",
    "",
    "IMPACT — lands the point instead of trailing off.",
    "1: stops without a conclusion, or fades into 'and yeah, that's about it'.",
    "2: states an outcome with no sense of whether it mattered.",
    "3: a clear outcome, no measure of size.",
    "4: a clear outcome with a measure — time saved, cost cut, incidents avoided.",
    "5: outcome, measure, and what they would do differently now.",
    "",
    "Domain notes for this role. Reward answers that name the specific AWS",
    "service and say why it was chosen over the neighbouring one — EC2 versus",
    "Lambda versus Fargate, S3 storage classes, RDS versus DynamoDB, ALB versus",
    "NLB. Reward attention to IAM least privilege, VPC layout, multi-AZ and",
    "failure modes, cost control, and observability, because interviewers for",
    "these roles ask about all of them. In Python, reward boto3 fluency, error",
    "and retry handling, testing, and knowing when a script should have been a",
    "managed service instead. Treat 'we used the cloud' or 'I wrote a script' as",
    "the vague answers they are, and say so.",
    "",
    "Common situations, and what to do with them.",
    "If the answer rambles, do not summarise it back — name the shape it was",
    "missing and move on. If they say they don't know, say what a good answer",
    "would have contained in one sentence, then ask something adjacent they can",
    "answer; score what they gave you, which is low, without any commentary on",
    "them. If they give a hypothetical when asked for experience, note the",
    "difference plainly and ask for a real instance. If they answer well, say so",
    "in one sentence and spend the rest pushing further — a strong candidate",
    "learns nothing from being told they were strong. If the answer is very",
    "short, ask for the part they skipped rather than listing everything absent.",
    "",
    "Everything before the final line is spoken aloud, so avoid markdown, code",
    "fences, bullet characters, emoji, and anything that only makes sense on a",
    "screen. Write it the way you would say it.",
    "",
    "If the candidate asks a clarifying question instead of answering, answer it",
    "briefly in character and omit the final line entirely.",
  ].join("\n");

  /**
   * Anthropic's SSE in, our two-shape SSE out.
   *
   * Anthropic frames each event across multiple lines and interleaves
   * ping/error/lifecycle events with the text deltas. Everything that
   * isn't a text delta is dropped here, so the client's reader is a
   * dozen lines instead of a parser.
   */
  function simplify(env, onSpend) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    // What this turn consumed, filled in as the stream reveals it.
    // Anthropic splits the four numbers across two events: the input
    // classes are known at message_start, the output total only at
    // message_delta once the model has stopped.
    const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

    return new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });

        // Complete lines only — a delta can be split across chunks.
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          report(line);
          meter(line);
          const text = textOf(line);
          if (text) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          }
        }
      },

      flush(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
        if (onSpend) {
          onSpend(Pricing.costOf(model(env), usage), usage);
        }
      },
    });

    /**
     * Keep a running count of the four billable token classes.
     *
     * Tolerant of missing fields by design. A usage shape that gains a
     * field should cost slightly less than it truly does for one deploy,
     * rather than throwing inside a transform and taking the candidate's
     * half-finished answer down with it. The invariant that matters is
     * that the stream survives; the money is reconciled against a
     * provisional charge that was already the worst case.
     */
    function meter(line) {
      if (!line.startsWith("data:")) return;
      try {
        const event = JSON.parse(line.slice(5));
        const counts = (event.message && event.message.usage) || event.usage;
        if (!counts) return;

        usage.input += counts.input_tokens || 0;
        usage.cacheWrite += counts.cache_creation_input_tokens || 0;
        usage.cacheRead += counts.cache_read_input_tokens || 0;

        // Cumulative, not incremental: message_delta reports the total so
        // far, so this is the last word rather than a running sum.
        if (counts.output_tokens) {
          usage.output = counts.output_tokens;
        }
      } catch (err) {
        // Not our business — the stream is still the stream.
      }
    }

    /**
     * Note whether the cache actually engaged, once per turn.
     *
     * Worth logging rather than assuming, because the failure mode is
     * silent: a prefix under the model's minimum is simply not cached
     * and no error says so. Both counters reading zero is the signal
     * that the instructions have drifted below 1,024 tokens and every
     * call is paying full price for them.
     */
    function report(line) {
      if (!line.startsWith("data:")) return;
      try {
        const event = JSON.parse(line.slice(5));
        if (event.type !== "message_start") return;

        const usage = event.message.usage;
        const written = usage.cache_creation_input_tokens || 0;
        const read = usage.cache_read_input_tokens || 0;
        if (written === 0 && read === 0) {
          console.warn(
            "Coach: prompt cache did not engage — the instructions are probably",
            "under the model's minimum cacheable length."
          );
          return;
        }
        console.log(`Coach: cache read ${read}, written ${written}, fresh ${usage.input_tokens}.`);
      } catch (err) {
        // Not our business — the stream is still the stream.
      }
    }

    /** The text a `data:` line carries, or "" for every other line. */
    function textOf(line) {
      if (!line.startsWith("data:")) {
        return "";
      }
      try {
        const event = JSON.parse(line.slice(5));
        const isText =
          event.type === "content_block_delta" && event.delta.type === "text_delta";
        return isText ? event.delta.text : "";
      } catch (err) {
        return "";
      }
    }
  }

  /**
   * Keep the conversation bounded. A practice session is short by
   * nature, so anything longer is either a stuck client or someone
   * treating the endpoint as a free chatbot.
   */
  function trim(messages) {
    const clean = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
      .slice(-MAX_TURNS)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_CHARS) }));

    return fold(clean);
  }

  /**
   * Merge neighbours that share a role.
   *
   * Anthropic requires the roles to alternate and rejects the whole
   * request when they don't. A client can produce two in a row honestly
   * — stopping a reply before a single word was spoken leaves a turn
   * with nothing to record for the interviewer — and losing the request
   * over it would turn a stop into an error. Folding keeps every word
   * the candidate said and costs nothing when the roles already
   * alternate, which is the normal case.
   */
  function fold(messages) {
    const folded = [];
    for (const message of messages) {
      const last = folded[folded.length - 1];
      if (last && last.role === message.role) {
        last.content = `${last.content}\n\n${message.content}`.slice(0, MAX_CHARS);
      } else {
        folded.push(message);
      }
    }
    return folded;
  }

  return { converse, estimate };
})();

/* ---------------------------------------------------------- */
/* 8. ADMIN                                                    */
/* ---------------------------------------------------------- */

/**
 * Minting and inspecting invite codes.
 *
 * Three operations, no UI, because the population being administered is
 * a handful of beta testers and a page to manage them would be more code
 * than the thing it manages. curl and `wrangler d1 execute` both reach
 * the same rows; see README for the exact commands.
 *
 * Guarded by ADMIN_TOKEN, and unreachable — 404, not 401 — when that
 * secret is unset. An admin route that announces itself on a deployment
 * with no token configured is an invitation; one that does not exist
 * yet is just a 404 among all the other 404s.
 */
const Admin = (() => {
  const DEFAULT_CAP_USD = 0.5;
  const MAX_CAP_USD = 100;

  function authorised(env, request) {
    const expected = env.ADMIN_TOKEN || "";
    const supplied = request.headers.get("x-admin-token") || "";
    if (!expected || !supplied) {
      return false;
    }
    return Credentials.constantTimeEqual(supplied, expected);
  }

  /** Every code, dearest first — the ones worth looking at are the ones being spent. */
  async function list(db) {
    const result = await db
      .prepare(
        `SELECT code, label, cap_usd, spent_usd, turns, active, created_at, last_used_at
           FROM invite_codes ORDER BY spent_usd DESC, created_at DESC`
      )
      .all();

    return (result.results || []).map(toCode);
  }

  /**
   * Mint one. The code is returned in full exactly once, here — it is
   * stored in plain text, so it can be read back later too, which is the
   * right trade for a $0.50 budget token that gets pasted into a chat.
   */
  async function create(db, body) {
    const code = Access.mint();
    const cap = clampCap(body.cap_usd);
    const label = String(body.label || "").slice(0, 80);

    await db
      .prepare(
        `INSERT INTO invite_codes (code, label, cap_usd, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(code, label, cap, new Date().toISOString())
      .run();

    return toCode(await Access.find(db, code));
  }

  /**
   * Change a cap or switch a code off.
   *
   * Raising the cap on a code that already hit it revives it, which is
   * the point: "usage limit reached" should be a conversation, not a
   * dead end, and the fix is one PATCH rather than a new code and a
   * re-onboarding.
   *
   * Revoking is `active: false`, and it is deliberately not a delete.
   * `spent_usd` and `turns` survive, so what a code cost stays readable
   * after it is switched off — and the accounts that used it keep their
   * case files, their XP and their sync, losing only the two AI modes.
   * A revoked code stops working immediately regardless of how much of
   * its cap is unspent; `Access.summary` treats `active = 0` and a spent
   * cap the same way.
   *
   * Returns { code, wasActive } so the caller can tell a revocation from
   * a no-op, or null when there is no such code.
   */
  async function update(db, code, body) {
    const existing = await Access.find(db, code);
    if (!existing) {
      return null;
    }

    const cap = body.cap_usd === undefined ? existing.cap_usd : clampCap(body.cap_usd);
    const active =
      body.active === undefined ? existing.active : body.active ? 1 : 0;

    await db
      .prepare("UPDATE invite_codes SET cap_usd = ?, active = ? WHERE code = ?")
      .bind(cap, active, existing.code)
      .run();

    return {
      code: toCode(await Access.find(db, existing.code)),
      wasActive: existing.active === 1,
    };
  }

  /**
   * Switch every live code off at once.
   *
   * One statement rather than a list-then-patch loop in the browser.
   * A loop would be N round trips that can fail halfway, leaving some
   * codes off and some on with nothing to say which — and "revoke
   * everything" is precisely the operation where a partial result is
   * worse than no result.
   *
   * Returns how many were actually switched off. Codes that were already
   * inactive are excluded by the WHERE clause and so are not counted:
   * they were not revoked by this call, and saying otherwise would
   * inflate the number on the one screen that exists to be believed.
   */
  async function revokeAll(db) {
    const result = await db
      .prepare("UPDATE invite_codes SET active = 0 WHERE active = 1")
      .run();

    return (result.meta && result.meta.changes) || 0;
  }

  /** Bounded because a typo in a cap is a typo in a credit limit. */
  function clampCap(value) {
    const cap = Number(value);
    if (!Number.isFinite(cap) || cap <= 0) {
      return DEFAULT_CAP_USD;
    }
    return Math.min(cap, MAX_CAP_USD);
  }

  function toCode(row) {
    return {
      code: row.code,
      label: row.label,
      cap_usd: Access.round(row.cap_usd),
      spent_usd: Access.round(row.spent_usd),
      remaining_usd: Access.round(Math.max(0, row.cap_usd - row.spent_usd)),
      turns: row.turns,
      active: row.active === 1,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    };
  }

  return { authorised, list, create, update, revokeAll };
})();

/* ---------------------------------------------------------- */
/* 9. HEALTH                                                   */
/* ---------------------------------------------------------- */

/**
 * Answers "is this deployment wired up?" without needing an account.
 *
 * This exists because of a real outage: the Worker was renamed, the D1
 * database was recreated, and the schema was never applied to the new
 * one. Every API call died on `no such table: detectives`, and the
 * router's catch-all flattened that into one opaque sentence — the site
 * said the case files were unreachable while the binding was fine and
 * the database was simply empty. Three plausible causes, no way to tell
 * them apart from outside.
 *
 * The rule here: report presence, never contents. A missing secret is
 * worth knowing about; its value is not something an unauthenticated
 * route should ever be able to confirm.
 */
const Health = (() => {
  /** Tables the Worker cannot function without. */
  const REQUIRED_TABLES = ["detectives", "sessions", "case_log", "invite_codes", "session_drafts"];

  /**
   * The command that creates each table, for a database that is missing
   * some but not all of them.
   *
   * Keyed by table rather than reported as one blanket "run the
   * migrations", because the two migrations are not interchangeable:
   * 0001 fails loudly on a second run by design, so telling someone to
   * apply both when they only need the second hands them an error that
   * looks like a failure and isn't.
   */
  const CREATED_BY = {
    invite_codes: "npm run db:migrate:remote",
    session_drafts: "npm run db:migrate:drafts:remote",
  };

  async function read(env) {
    const report = {
      ok: false,
      db_bound: Boolean(env.DB),
      schema_ready: false,
      missing_tables: REQUIRED_TABLES.slice(),
      anthropic_key_set: Boolean(env.ANTHROPIC_API_KEY),
      // Presence, never value. Both of these being false is the signal
      // that the access tiers are configured but unusable: nobody can
      // sign in as the owner and nobody can mint an invite code, so the
      // deployment has manual scoring and nothing else.
      owner_passphrase_set: Boolean(env.OWNER_PASSPHRASE),
      admin_token_set: Boolean(env.ADMIN_TOKEN),
    };

    if (!report.db_bound) {
      report.hint = "No DB binding. Check [[d1_databases]] in wrangler.toml, then redeploy.";
      return report;
    }

    try {
      // Placeholders counted from the list rather than written out.
      // They were written out once, and adding a fifth required table
      // left four of them — SQLite bound the first four names, found
      // them all, and reported the fifth missing forever.
      const slots = REQUIRED_TABLES.map(() => "?").join(", ");
      const found = await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${slots})`
      )
        .bind(...REQUIRED_TABLES)
        .all();

      const names = (found.results || []).map((row) => row.name);
      report.missing_tables = REQUIRED_TABLES.filter((t) => !names.includes(t));
      report.schema_ready = report.missing_tables.length === 0;
      report.ok = report.schema_ready;

      if (!report.schema_ready) {
        // A brand new database is missing everything; one that predates
        // a feature is missing exactly the tables that feature added.
        // Same symptom, different commands, so the hint says which.
        report.hint =
          report.missing_tables.length === REQUIRED_TABLES.length
            ? "Database is empty. Run: npm run db:init:remote"
            : `Database predates a schema change. Run: ${commandsFor(report.missing_tables)}`;
      }
    } catch (err) {
      report.hint = `Database unreachable: ${err.message}`;
    }

    return report;
  }

  /**
   * The migrations that would create these tables, in order, deduped.
   *
   * A table with no entry in CREATED_BY predates the migrations
   * directory entirely, which means this database is old enough that
   * re-running schema.sql is the honest advice — every statement in it
   * is IF NOT EXISTS, so it costs nothing on the tables already there.
   */
  function commandsFor(missing) {
    const commands = missing.map((table) => CREATED_BY[table] || "npm run db:init:remote");
    return [...new Set(commands)].join(" && ");
  }

  return { read };
})();

/* ---------------------------------------------------------- */
/* 10. ROUTER                                                  */
/* ---------------------------------------------------------- */

async function handleApi(request, env, ctx, path) {
  // Deliberately unauthenticated and deliberately first: every other
  // route needs the DB, so when the DB is the thing that's broken there
  // is nowhere else to ask. Booleans only — this says whether the
  // deployment is wired up, never what it is wired up to.
  if (path === "/api/health" && request.method === "GET") {
    return Responses.json(await Health.read(env));
  }

  // Admin sits ahead of the session check because it is not a detective
  // doing this — it is whoever holds ADMIN_TOKEN, from a terminal, with
  // no account and no interest in one.
  if (path.startsWith("/api/admin/")) {
    return handleAdmin(request, env, path);
  }

  if (path === "/api/session" && request.method === "POST") {
    const body = await readJson(request);
    // `code` is the field the login form fills; `password` is accepted as
    // an alias so an older cached copy of the page still signs in.
    const secret = body.code || body.password || "";
    const session = await Detectives.openSession(env.DB, env, body.username, secret);
    if (session.error) {
      return Responses.fail(session.error, 401);
    }
    return Responses.json({
      token: session.token,
      username: session.username,
      access: await Access.summary(env.DB, env, session),
      log: await CaseLog.read(env.DB, session.id),
    });
  }

  // Everything past this point needs a session.
  const detective = await Detectives.fromRequest(env.DB, request);
  if (!detective) {
    return Responses.fail("Not signed in.", 401);
  }

  // Lets a long-lived tab notice a cap being hit, or raised, without a
  // sign-out and back in.
  if (path === "/api/access" && request.method === "GET") {
    return Responses.json({ access: await Access.summary(env.DB, env, detective) });
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

  // Saved practice sessions. Free of tier checks on purpose: a draft is
  // text this account already produced, and re-reading your own words
  // costs nothing at api.anthropic.com. An invite code that has spent
  // its cap can still save and resume; it simply can't be replied to.
  if (path === "/api/drafts" && request.method === "GET") {
    return Responses.json({ drafts: await Drafts.list(env.DB, detective.id) });
  }

  if (path.startsWith("/api/drafts/")) {
    const caseId = Number(path.slice("/api/drafts/".length));
    if (!Number.isInteger(caseId)) {
      return Responses.fail("No such case file.", 404);
    }

    if (request.method === "GET") {
      return Responses.json({ draft: await Drafts.read(env.DB, detective.id, caseId) });
    }

    // PUT, not POST. Saving a session twice has to land on the same row
    // with the same result, and the method should say so — the client
    // retries this on a flaky connection and must not be able to leave
    // two half-drafts behind.
    if (request.method === "PUT") {
      const body = await readJson(request);
      const draft = await Drafts.save(env.DB, detective.id, caseId, body.mode, body.messages);
      if (!draft) {
        return Responses.fail("That session had nothing in it to save.", 400);
      }
      return Responses.json({ draft });
    }

    if (request.method === "DELETE") {
      await Drafts.remove(env.DB, detective.id, caseId);
      return Responses.json({ draft: null });
    }
  }

  // The only route that spends money, and the only one that is tiered.
  //
  // The order below is the whole feature: decide, charge, then call.
  // Anything that reaches api.anthropic.com before the charge lands is a
  // request that got billed without being authorised, and the way to
  // guarantee that never happens is to never write it in that order.
  if (path === "/api/coach" && request.method === "POST") {
    const body = await readJson(request);
    const question = String(body.question || "").slice(0, 500);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!question || messages.length === 0) {
      return Responses.fail("No question to work.", 400);
    }

    const access = await Access.summary(env.DB, env, detective);

    if (access.tier === "free") {
      return Responses.fail(
        "AI coaching needs an invite code. Manual scoring and Send to Claude are open to everyone — " +
          "pick Send to Claude to practise this case at no cost.",
        403
      );
    }

    // The owner's turns are unmetered, so there is nothing to charge and
    // nothing to settle.
    if (access.tier === "owner") {
      return Coach.converse(env, question, messages, null);
    }

    // Charge the worst case first and refund the difference afterwards.
    // Doing it the intuitive way round — call, then bill what it cost —
    // means the cap is only ever checked against turns that have already
    // finished, and a burst of simultaneous requests all pass a check
    // that none of them have yet paid for.
    const held = Coach.estimate(env, question, messages);
    if (!(await Access.charge(env.DB, access.code, held))) {
      return Responses.fail(
        `Usage limit reached — this invite code has spent its $${access.cap.toFixed(2)} of AI coaching. ` +
          "Manual scoring and Send to Claude still work; ask Kheera to raise the cap to carry on.",
        402
      );
    }

    let response;
    try {
      response = await Coach.converse(env, question, messages, (spent) => {
        // Fired from inside the stream, after the response object has
        // already been returned. waitUntil is what keeps the invocation
        // alive long enough for the write to land.
        ctx.waitUntil(Access.settle(env.DB, access.code, held, spent));
      });
    } catch (err) {
      await Access.refund(env.DB, access.code, held);
      throw err;
    }

    // A 502 or 503 from Coach never reaches the stream, so it never
    // reaches the settle callback either. Without this the code would be
    // billed a full turn's ceiling for an outage it had no part in.
    if (!response.ok) {
      await Access.refund(env.DB, access.code, held);
    }

    return response;
  }

  return Responses.fail("No such case file.", 404);
}

/**
 * The invite-code admin surface. See the Admin module for why this is
 * 404 rather than 401 when ADMIN_TOKEN is unset.
 */
async function handleAdmin(request, env, path) {
  if (!Admin.authorised(env, request)) {
    return Responses.fail("No such case file.", 404);
  }

  if (path === "/api/admin/codes" && request.method === "GET") {
    return Responses.json({ codes: await Admin.list(env.DB) });
  }

  if (path === "/api/admin/codes" && request.method === "POST") {
    return Responses.json({ code: await Admin.create(env.DB, await readJson(request)) }, 201);
  }

  // Ahead of the per-code PATCH below, and a POST rather than a PATCH,
  // so it can never be mistaken for an operation on a code that happens
  // to be named "revoke-all". Codes are minted as CASE-XXXX-XXXX-XXXX,
  // so that name is unreachable — but relying on that would make this
  // route's safety depend on the shape of a string generated elsewhere.
  if (path === "/api/admin/codes/revoke-all" && request.method === "POST") {
    return Responses.json({ revoked: await Admin.revokeAll(env.DB) });
  }

  if (path.startsWith("/api/admin/codes/") && request.method === "PATCH") {
    const code = decodeURIComponent(path.slice("/api/admin/codes/".length));
    const result = await Admin.update(env.DB, code, await readJson(request));

    // Same 404 as a bad token, deliberately — but carrying a reason,
    // which a bad token never gets. Anyone who can see this field has
    // already proved they hold ADMIN_TOKEN, so telling them whether a
    // code exists reveals nothing they couldn't read off the list route.
    if (!result) {
      return Responses.fail("No invite code by that name.", 404, "unknown_code");
    }

    // `was_active` is what makes revoking honest on screen: switching off
    // a code that was already off is a no-op, and reporting it as a fresh
    // revocation would tell someone they had just cut off access that had
    // been cut off for a week.
    return Responses.json({ code: result.code, was_active: result.wasActive });
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
  // ctx is here for one reason: /api/coach settles its bill after the
  // response has already started streaming, and waitUntil is the only
  // thing that keeps the invocation alive long enough for that write.
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;

    if (!path.startsWith(API_PREFIX)) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApi(request, env, ctx, path);
    } catch (err) {
      // Log the route and the actual message, not just the object. The
      // opaque version of this line cost an evening: `wrangler tail`
      // showed "API failure" and nothing about which call or why.
      console.error(`API failure [${request.method} ${path}]:`, err && err.message, err);

      // A missing table is a deployment mistake, not an outage, and it
      // is worth saying so — the user cannot fix it, but the person
      // reading the screenshot can.
      if (err && /no such table/i.test(String(err.message))) {
        return Responses.fail(
          "The case files haven't been set up yet — the database is empty. See /api/health.",
          503
        );
      }

      return Responses.fail("The case files are unreachable right now.", 500);
    }
  },
};
