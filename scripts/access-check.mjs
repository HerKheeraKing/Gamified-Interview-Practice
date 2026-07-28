/**
 * scripts/access-check.mjs
 * ------------------------------------------------------------
 * Does the spend cap actually hold?
 *
 * The access tiers are the one part of this site where a bug costs
 * money rather than a bad afternoon, and every claim they make is the
 * kind that looks true by inspection: "the free tier never calls the
 * API", "a code stops at its cap", "the owner needs the passphrase".
 * This runs the real Worker against a real SQLite database and a fake
 * Anthropic, and checks each of those claims by observing behaviour
 * rather than reading the code back.
 *
 *   npm run check:access
 *
 * Offline and free. The Anthropic endpoint is stubbed with a stream
 * carrying known token counts, so the cost arithmetic is checkable
 * against a number worked out by hand rather than against a bill.
 *
 * The one thing it cannot cover is a client that disconnects mid-turn:
 * the settle runs in the stream's flush, and an aborted stream never
 * flushes, so the provisional hold stands. That is the safe direction —
 * a code is over-billed by at most one turn's ceiling, never under —
 * and it is why the hold is sized to the turn rather than to the
 * MAX_TURNS × MAX_CHARS limit. See Pricing.ceiling.
 * ------------------------------------------------------------
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------------------------------------------------------- */
/* A D1 the Worker can't tell from the real one                */
/* ---------------------------------------------------------- */

/**
 * Only the four methods worker/index.js actually calls. A fuller shim
 * would be a second implementation of D1 to keep correct, and every
 * method it gained would be one the Worker isn't using.
 */
function fakeD1(db) {
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: db.prepare(sql).run(...args) }),
    __run: () => db.prepare(sql).run(...args),
  });

  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => statements.map((s) => s.__run()),
  };
}

/**
 * An Anthropic that bills a known amount.
 *
 * The numbers below are the ones the assertions are worked out from:
 * 500 fresh input tokens, a 1,500-token cache write, 200 output. On
 * claude-sonnet-5 at $3 / $3.75 / $15 per MTok that is
 *   500×3 + 1500×3.75 + 200×15  =  1500 + 5625 + 3000  =  10,125
 * millionths of a dollar, or $0.010125 exactly.
 */
const TURN_COST_USD = 0.010125;

function fakeAnthropic() {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 500, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Tighter on the result. " } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "What did it cost?\n" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: '[[SCORES]]{"structure":3,"relevance":3,"clarity":3,"evidence":2,"impact":2}' } },
    { type: "message_delta", usage: { output_tokens: 200 } },
  ];

  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200 });
}

/* ---------------------------------------------------------- */
/* Harness                                                     */
/* ---------------------------------------------------------- */

const OWNER_PASSPHRASE = "the-butler-did-it";
const ADMIN_TOKEN = "admin-token-for-tests";

let worker;
let env;
let pending = [];

async function boot() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(ROOT, "schema.sql"), "utf8"));

  env = {
    DB: fakeD1(db),
    ASSETS: { fetch: async () => new Response("static") },
    ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
    COACH_MODEL: "claude-sonnet-5",
    OWNER_PASSPHRASE,
    ADMIN_TOKEN,
  };

  globalThis.fetch = async (url) => {
    if (String(url).includes("api.anthropic.com")) {
      return fakeAnthropic();
    }
    throw new Error(`Unexpected outbound call to ${url}`);
  };

  worker = (await import(new URL("../worker/index.js", import.meta.url))).default;
}

/** One request through the Worker, with waitUntil work drained before returning. */
async function call(path, { method = "GET", token, admin, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers["x-admin-token"] = admin;

  const ctx = { waitUntil: (p) => pending.push(p) };
  const request = new Request(`https://example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const response = await worker.fetch(request, env, ctx);

  // Streamed routes settle their bill in the stream's flush, so the body
  // has to be drained before the settle has even been scheduled.
  const text = await response.text();
  await Promise.all(pending);
  pending = [];

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = null;
  }

  return { status: response.status, text, json };
}

const coachTurn = (token) =>
  call("/api/coach", {
    method: "POST",
    token,
    body: { question: "Tell me about a time you cut cloud spend.", messages: [{ role: "user", content: "We moved to Lambda." }] },
  });

/* ---------------------------------------------------------- */
/* Checks                                                      */
/* ---------------------------------------------------------- */

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Compares reported dollars, which are rounded to the tenth of a cent on
 * the way out of Access.summary. The stored figure is full precision —
 * the tolerance here is the rounding, not slack in the arithmetic.
 */
function near(label, actual, expected, tolerance = 5e-5) {
  const ok = Math.abs(actual - expected) < tolerance;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}`);
  if (!ok) console.log(`        expected ~${expected}, got ${actual}`);
}

async function main() {
  await boot();

  console.log("\nOWNER");
  const wrong = await call("/api/session", { method: "POST", body: { username: "kheera", code: "guess" } });
  check("wrong passphrase is refused", wrong.status, 401);

  const squat = await call("/api/session", { method: "POST", body: { username: "KHEERA" } });
  check("owner codename can't be squatted without the passphrase", squat.status, 401);

  const owner = await call("/api/session", { method: "POST", body: { username: "Kheera", code: OWNER_PASSPHRASE } });
  check("passphrase signs the owner in", owner.status, 200);
  check("owner tier", owner.json.access.tier, "owner");

  const ownerTurn = await coachTurn(owner.json.token);
  check("owner reaches the interviewer", ownerTurn.status, 200);
  check("owner gets the coaching stream", ownerTurn.text.includes("Tighter on the result"), true);

  console.log("\nFREE");
  const free = await call("/api/session", { method: "POST", body: { username: "stranger" } });
  check("any codename still signs in", free.status, 200);
  check("free tier", free.json.access.tier, "free");
  check("free tier has no AI", free.json.access.ai, false);

  const freeTurn = await coachTurn(free.json.token);
  check("free tier is refused", freeTurn.status, 403);
  check("refusal names the free path", freeTurn.json.error.includes("Send to Claude"), true);

  const badCode = await call("/api/session", { method: "POST", body: { username: "hopeful", code: "CASE-XXXX-XXXX-XXXX" } });
  check("an invented code is refused", badCode.status, 401);

  console.log("\nADMIN");
  const noToken = await call("/api/admin/codes");
  check("admin is invisible without the token", noToken.status, 404);

  const wrongToken = await call("/api/admin/codes", { admin: "nope" });
  check("admin is invisible with the wrong token", wrongToken.status, 404);

  const minted = await call("/api/admin/codes", { method: "POST", admin: ADMIN_TOKEN, body: { label: "beta: sam", cap_usd: 0.05 } });
  check("a code is minted", minted.status, 201);
  check("cap is recorded", minted.json.code.cap_usd, 0.05);
  check("code is readable", /^CASE(-[A-Z2-9]{4}){3}$/.test(minted.json.code.code), true);

  // The login modal's minting panel refuses a wrong token client-side
  // too, but the claim that matters is this one: a rejected mint leaves
  // no row behind. A panel that showed an error while quietly creating a
  // code would be worse than one that failed outright.
  const before = (await call("/api/admin/codes", { admin: ADMIN_TOKEN })).json.codes.length;
  const refused = await call("/api/admin/codes", { method: "POST", admin: "wrong", body: { cap_usd: 5 } });
  const after = (await call("/api/admin/codes", { admin: ADMIN_TOKEN })).json.codes.length;
  check("a bad token can't mint", refused.status, 404);
  check("and creates nothing", after, before);

  // The panel sends a number it has already range-checked; the Worker
  // clamps regardless, because the panel is not the only possible caller.
  const absurd = await call("/api/admin/codes", { method: "POST", admin: ADMIN_TOKEN, body: { cap_usd: 500 } });
  check("an absurd cap is clamped, not honoured", absurd.json.code.cap_usd, 100);

  const defaulted = await call("/api/admin/codes", { method: "POST", admin: ADMIN_TOKEN, body: {} });
  check("a missing cap defaults to $0.50", defaulted.json.code.cap_usd, 0.5);

  const code = minted.json.code.code;

  console.log("\nINVITED");
  const guest = await call("/api/session", { method: "POST", body: { username: "sam", code } });
  check("a valid code signs in", guest.status, 200);
  check("invited tier", guest.json.access.tier, "invited");
  check("invited has AI", guest.json.access.ai, true);

  const guestTurn = await coachTurn(guest.json.token);
  check("invited reaches the interviewer", guestTurn.status, 200);

  const afterOne = await call("/api/access", { token: guest.json.token });
  near("one turn is billed at real cost", afterOne.json.access.spent, TURN_COST_USD);
  check("the hold was refunded, not kept", afterOne.json.access.spent < 0.02, true);

  // A $0.05 cap at ~$0.0101 a turn is four more turns before the fifth
  // finds the balance already over the line.
  let turns = 1;
  for (let i = 0; i < 10; i++) {
    const turn = await coachTurn(guest.json.token);
    if (turn.status === 402) break;
    turns++;
  }
  check("the cap stops the session", turns, 5);

  const blocked = await coachTurn(guest.json.token);
  check("further turns are refused", blocked.status, 402);
  check("refusal says why", blocked.json.error.includes("Usage limit reached"), true);
  check("refusal names the free path", blocked.json.error.includes("Send to Claude"), true);

  const spent = await call("/api/access", { token: guest.json.token });
  check("the tier reports itself exhausted", spent.json.access.ai, false);
  near("total spend is five turns", spent.json.access.spent, TURN_COST_USD * 5);

  console.log("\nRAISING THE CAP");
  const raised = await call(`/api/admin/codes/${code}`, { method: "PATCH", admin: ADMIN_TOKEN, body: { cap_usd: 1 } });
  check("cap is raised", raised.json.code.cap_usd, 1);

  const resumed = await coachTurn(guest.json.token);
  check("the session resumes", resumed.status, 200);

  console.log("\nREVOKING");

  // The point of revoking rather than waiting for the cap: this code has
  // most of its $1 unspent and is still switched off on the next turn.
  const live = await call("/api/admin/codes", { admin: ADMIN_TOKEN });
  const target = live.json.codes.find((c) => c.code === code);
  check("the code still has budget left", target.remaining_usd > 0.9, true);

  const off = await call(`/api/admin/codes/${code}`, { method: "PATCH", admin: ADMIN_TOKEN, body: { active: false } });
  check("revoke succeeds", off.status, 200);
  check("and reports it was live until now", off.json.was_active, true);
  check("the code reads as inactive", off.json.code.active, false);
  check("spend history survives revocation", off.json.code.spent_usd > 0, true);

  const revoked = await coachTurn(guest.json.token);
  check("a revoked code loses AI despite unspent budget", revoked.status, 403);

  const demoted = await call("/api/access", { token: guest.json.token });
  check("and falls back to free rather than erroring", demoted.json.access.tier, "free");

  const stillSyncs = await call("/api/log", { token: guest.json.token });
  check("but keeps their case files", stillSyncs.status, 200);

  const again = await call(`/api/admin/codes/${code}`, { method: "PATCH", admin: ADMIN_TOKEN, body: { active: false } });
  check("revoking twice is a no-op, and says so", again.json.was_active, false);

  // The panel has to tell a wrong token from a wrong code, and both are
  // 404. Only the second carries a reason — a bad token gets none, so it
  // can't be used to probe which codes exist.
  const unknown = await call("/api/admin/codes/CASE-ZZZZ-ZZZZ-ZZZZ", { method: "PATCH", admin: ADMIN_TOKEN, body: { active: false } });
  check("an unknown code is 404", unknown.status, 404);
  check("and is distinguishable", unknown.json.reason, "unknown_code");

  const noAuth = await call(`/api/admin/codes/${code}`, { method: "PATCH", admin: "wrong", body: { active: false } });
  check("a bad token on revoke is 404", noAuth.status, 404);
  check("and carries no reason to probe with", noAuth.json.reason, undefined);

  const restored = await call(`/api/admin/codes/${code}`, { method: "PATCH", admin: ADMIN_TOKEN, body: { active: true } });
  check("revocation is reversible", restored.json.code.active, true);
  check("and the session comes back", (await coachTurn(guest.json.token)).status, 200);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
