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
 *   5. Coach        - the only place that holds the Anthropic API key
 *   6. Health       - is this deployment wired up? (bindings, schema)
 *   7. Router       - maps requests to the layers above
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
/* 5. COACH                                                    */
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

  // Must match the `key` values in public/assets/js/questions.js.
  // The client ignores any key it doesn't recognise, so adding a
  // category here before adding it there degrades quietly.
  const RUBRIC = [
    ["structure", "Clear STAR-style frame (Situation, Task, Action, Result) rather than a ramble"],
    ["relevance", "Actually answers the question that was asked"],
    ["clarity", "Concise, confident delivery with little filler"],
    ["evidence", "Specific details — tools, numbers, named outcomes"],
    ["impact", "Lands the point cleanly instead of trailing off"],
  ];

  const SCORE_MARKER = "[[SCORES]]";

  /**
   * Run one interviewer turn. Resolves to a Response carrying the
   * simplified event stream described above.
   */
  async function converse(env, question, messages) {
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
        model: env.COACH_MODEL || DEFAULT_MODEL,
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

    return new Response(upstream.body.pipeThrough(simplify()), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  function systemPrompt(question) {
    const rubric = RUBRIC.map(([key, hint]) => `- ${key}: ${hint}`).join("\n");

    return [
      "You are a warm but exacting technical interviewer running a mock interview.",
      "",
      `The question on the table is: "${question}"`,
      "",
      "The candidate is practising for cloud engineering roles (AWS, Python).",
      "They are speaking or typing an answer to that question and nothing else.",
      "",
      "Every time the candidate answers, reply in this order:",
      "1. Two to four sentences of specific coaching. Name what actually worked",
      "   and the single highest-value thing to change. Quote their own words back",
      "   when it helps. No generic praise, no bullet lists, no headings.",
      "2. One short follow-up question a real interviewer would ask next.",
      "3. On its own final line, exactly this and nothing after it:",
      `   ${SCORE_MARKER}{"structure":N,"relevance":N,"clarity":N,"evidence":N,"impact":N}`,
      "",
      "Each N is an integer from 1 to 5 scoring that answer against:",
      rubric,
      "",
      "Score honestly — a vague answer with no specifics earns 2s, not 4s.",
      "Keep everything before the final line comfortable to read aloud: this is",
      "often spoken back to the candidate by a voice, so avoid markdown, code",
      "fences, emoji, and anything that only makes sense on a screen.",
      "",
      "If the candidate asks a clarifying question instead of answering, answer it",
      "briefly in character and omit the final line entirely.",
    ].join("\n");
  }

  /**
   * Anthropic's SSE in, our two-shape SSE out.
   *
   * Anthropic frames each event across multiple lines and interleaves
   * ping/error/lifecycle events with the text deltas. Everything that
   * isn't a text delta is dropped here, so the client's reader is a
   * dozen lines instead of a parser.
   */
  function simplify() {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    return new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });

        // Complete lines only — a delta can be split across chunks.
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const text = textOf(line);
          if (text) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          }
        }
      },

      flush(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      },
    });

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

  return { converse };
})();

/* ---------------------------------------------------------- */
/* 6. HEALTH                                                   */
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
  const REQUIRED_TABLES = ["detectives", "sessions", "case_log"];

  async function read(env) {
    const report = {
      ok: false,
      db_bound: Boolean(env.DB),
      schema_ready: false,
      missing_tables: REQUIRED_TABLES.slice(),
      anthropic_key_set: Boolean(env.ANTHROPIC_API_KEY),
    };

    if (!report.db_bound) {
      report.hint = "No DB binding. Check [[d1_databases]] in wrangler.toml, then redeploy.";
      return report;
    }

    try {
      const found = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)"
      )
        .bind(...REQUIRED_TABLES)
        .all();

      const names = (found.results || []).map((row) => row.name);
      report.missing_tables = REQUIRED_TABLES.filter((t) => !names.includes(t));
      report.schema_ready = report.missing_tables.length === 0;
      report.ok = report.schema_ready;

      if (!report.schema_ready) {
        report.hint = "Database is empty. Run: npm run db:init:remote";
      }
    } catch (err) {
      report.hint = `Database unreachable: ${err.message}`;
    }

    return report;
  }

  return { read };
})();

/* ---------------------------------------------------------- */
/* 7. ROUTER                                                   */
/* ---------------------------------------------------------- */

async function handleApi(request, env, path) {
  // Deliberately unauthenticated and deliberately first: every other
  // route needs the DB, so when the DB is the thing that's broken there
  // is nowhere else to ask. Booleans only — this says whether the
  // deployment is wired up, never what it is wired up to.
  if (path === "/api/health" && request.method === "GET") {
    return Responses.json(await Health.read(env));
  }

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

  // Sitting behind the session check above is deliberate: this is the
  // one route that spends money on every call, so it costs a codename.
  if (path === "/api/coach" && request.method === "POST") {
    const body = await readJson(request);
    const question = String(body.question || "").slice(0, 500);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!question || messages.length === 0) {
      return Responses.fail("No question to work.", 400);
    }
    return Coach.converse(env, question, messages);
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
