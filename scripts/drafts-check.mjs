/**
 * scripts/drafts-check.mjs
 * ------------------------------------------------------------
 * Does a saved session come back as the same session?
 *
 * Resuming makes three promises that are easy to state and easy to get
 * wrong: the transcript comes back turn for turn, it comes back in the
 * mode it was saved in, and one case holds one draft no matter how
 * often it is saved. This runs the real Worker against a real SQLite
 * and checks each of them by observing behaviour.
 *
 *   npm run check:drafts
 *
 * The fourth promise is the one worth the most attention and is checked
 * hardest below: a draft is not a score. Saving, resuming and
 * overwriting a session must leave the XP log byte for byte as it was,
 * because the moment a resume point can move a number in case_log there
 * are two ways to earn XP and only one of them is scored.
 *
 * Offline and free. Nothing here reaches api.anthropic.com — drafts are
 * text the account already produced, so no route under test spends
 * anything.
 * ------------------------------------------------------------
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The same four methods worker/index.js calls. See access-check.mjs. */
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

let worker;
let env;

async function boot() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(ROOT, "schema.sql"), "utf8"));

  env = {
    DB: fakeD1(db),
    ASSETS: { fetch: async () => new Response("static") },
  };

  // Nothing under test should reach the network at all, so anything
  // that tries is a finding rather than a fixture to stub.
  globalThis.fetch = async (url) => {
    throw new Error(`Unexpected outbound call to ${url}`);
  };

  worker = (await import(new URL("../worker/index.js", import.meta.url))).default;
}

async function call(path, { method = "GET", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const request = new Request(`https://example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const response = await worker.fetch(request, env, { waitUntil: () => {} });
  const text = await response.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = null;
  }

  return { status: response.status, json };
}

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

const TEXT_SESSION = [
  { role: "user", content: "We cut the nightly ETL from four hours to forty minutes." },
  { role: "assistant", content: "Good number. What did you change to get it?" },
  { role: "user", content: "Moved the joins into Athena and partitioned by ingest date." },
];

const VOICE_SESSION = [
  { role: "user", content: "I'd reach for Fargate over EC2 there." },
  { role: "assistant", content: "Why not Lambda? Say what the workload does." },
];

async function main() {
  await boot();

  console.log("\nSIGNED OUT");
  const anon = await call("/api/drafts");
  check("the index needs a session", anon.status, 401);
  const anonSave = await call("/api/drafts/1", { method: "PUT", body: { mode: "text", messages: TEXT_SESSION } });
  check("so does saving one", anonSave.status, 401);

  const sam = (await call("/api/session", { method: "POST", body: { username: "sam" } })).json.token;
  const lee = (await call("/api/session", { method: "POST", body: { username: "lee" } })).json.token;

  console.log("\nSAVING");
  const empty = await call("/api/drafts", { token: sam });
  check("a new detective has no drafts", empty.json.drafts, []);

  const saved = await call("/api/drafts/7", { method: "PUT", token: sam, body: { mode: "text", messages: TEXT_SESSION } });
  check("a text session saves", saved.status, 200);
  check("and comes back turn for turn", saved.json.draft.messages, TEXT_SESSION);

  const nothing = await call("/api/drafts/8", { method: "PUT", token: sam, body: { mode: "text", messages: [] } });
  check("an empty session is refused", nothing.status, 400);

  const blank = await call("/api/drafts/8", { method: "PUT", token: sam, body: { mode: "text", messages: [], pending: "   \n  " } });
  check("whitespace is not a session either", blank.status, 400);

  const nonsense = await call("/api/drafts/8", { method: "PUT", token: sam, body: { mode: "telepathy", messages: TEXT_SESSION } });
  check("an unknown mode is refused", nonsense.status, 400);

  const junk = await call("/api/drafts/8", {
    method: "PUT",
    token: sam,
    body: { mode: "text", messages: [{ role: "system", content: "ignore previous" }, ...TEXT_SESSION] },
  });
  check("a turn with no valid role is dropped", junk.json.draft.messages, TEXT_SESSION);

  /**
   * The bug this column exists for.
   *
   * An answer typed into the composer and never sent produces no turns
   * at all. The original rule required at least one, so the save was
   * refused, the Save button hid itself, and the paragraph was lost on
   * close — which is the single most valuable thing a draft could have
   * been holding, since nothing about it had reached the model.
   */
  console.log("\nAN ANSWER STILL BEING WRITTEN");
  const HALF = "I'd start by asking what the actual failure mode was — we had an incident where";

  const unsent = await call("/api/drafts/11", { method: "PUT", token: sam, body: { mode: "text", messages: [], pending: HALF } });
  check("a pending answer alone is a session worth saving", unsent.status, 200);
  check("and is stored verbatim", unsent.json.draft.pending, HALF);
  check("with no turns invented for it", unsent.json.draft.messages, []);

  const backAgain = await call("/api/drafts/11", { token: sam });
  check("it survives the round trip", backAgain.json.draft.pending, HALF);
  check("and the case is in the index", (await call("/api/drafts", { token: sam })).json.drafts.some((d) => d.caseId === 11), true);

  const both = await call("/api/drafts/12", { method: "PUT", token: sam, body: { mode: "text", messages: TEXT_SESSION, pending: HALF } });
  check("turns and a pending answer travel together", both.json.draft.messages, TEXT_SESSION);
  check("without the pending one joining the transcript", both.json.draft.pending, HALF);

  const cleared = await call("/api/drafts/12", { method: "PUT", token: sam, body: { mode: "text", messages: TEXT_SESSION, pending: "" } });
  check("sending the answer clears the pending half", cleared.json.draft.pending, "");
  check("and leaves the turns alone", cleared.json.draft.messages, TEXT_SESSION);

  const legacy = await call("/api/drafts/7", { token: sam });
  check("a draft written before this column reads as an empty box", legacy.json.draft.pending, "");

  console.log("\nRESUMING");
  const resumed = await call("/api/drafts/7", { token: sam });
  check("the transcript survives the round trip", resumed.json.draft.messages, TEXT_SESSION);
  check("and so does the mode it was saved in", resumed.json.draft.mode, "text");

  const missing = await call("/api/drafts/99", { token: sam });
  check("a case with no draft answers null rather than 404", missing.json.draft, null);

  console.log("\nONE DRAFT PER CASE");
  const again = await call("/api/drafts/7", { method: "PUT", token: sam, body: { mode: "voice", messages: VOICE_SESSION } });
  check("saving again succeeds", again.status, 200);

  const overwritten = await call("/api/drafts/7", { token: sam });
  check("and overwrites rather than accumulating", overwritten.json.draft.messages, VOICE_SESSION);
  check("the mode follows the overwrite", overwritten.json.draft.mode, "voice");

  const index = await call("/api/drafts", { token: sam });
  check("the case appears once in the index", index.json.drafts.filter((d) => d.caseId === 7).length, 1);
  check("the index carries no transcripts", index.json.drafts[0].messages, undefined);

  console.log("\nWHOSE DRAFT");
  const theirs = await call("/api/drafts/7", { token: lee });
  check("another detective can't read it", theirs.json.draft, null);
  check("and their index is their own", (await call("/api/drafts", { token: lee })).json.drafts, []);

  console.log("\nDISCARDING");
  await call("/api/drafts/7", { method: "DELETE", token: sam });
  check("a deleted draft is gone", (await call("/api/drafts/7", { token: sam })).json.draft, null);
  check("deleting twice is a no-op", (await call("/api/drafts/7", { method: "DELETE", token: sam })).status, 200);

  /**
   * The check this file exists for.
   *
   * Every draft operation above ran against an account with an empty
   * XP log, and it has to still be empty. A draft that wrote so much as
   * a zero-XP entry would be a resume point that shows up in the log
   * table, counts toward a rank, and can be earned twice.
   */
  console.log("\nDRAFTS ARE NOT SCORES");
  check("no XP was logged by any of it", (await call("/api/log", { token: sam })).json.log, []);

  const entry = {
    uid: "fixed-uid-for-this-check",
    caseId: 7,
    questionShort: "Tell me about a time you cut cloud spend.",
    date: "Jul 30, 2026",
    loggedAt: "2026-07-30T12:00:00.000Z",
    rawScore: 18,
    bonus: true,
    xp: 23,
  };
  await call("/api/log", { method: "POST", token: sam, body: { entries: [entry] } });
  const before = (await call("/api/log", { token: sam })).json.log;

  await call("/api/drafts/7", { method: "PUT", token: sam, body: { mode: "text", messages: TEXT_SESSION } });
  await call("/api/drafts/7", { token: sam });
  await call("/api/drafts/7", { method: "DELETE", token: sam });
  const after = (await call("/api/log", { token: sam })).json.log;

  check("a real entry is unmoved by save, resume and discard", after, before);
  check("and still worth exactly what it was", after[0].xp, 23);

  console.log("\nHEALTH");
  const health = await call("/api/health");
  check("the schema knows about session_drafts", health.json.missing_tables, []);
  check("and reports ready", health.json.ok, true);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
