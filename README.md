# The Interview Case Files

A gamified interview-practice tracker. Detective/RPG themed — behavioral
questions now, technical questions added in future rounds.

## Structure

```
.
├── public/                 # the served site — and nothing else
│   ├── index.html          # single-page app shell
│   └── assets/
│       ├── css/style.css   # design tokens + all styling
│       ├── js/questions.js # question bank + rank data (content, no logic)
│       ├── js/identity.js  # saved username + the only fetch() calls
│       ├── js/coach.js     # AI practice: Coach / Speaker / Voice / Handoff
│       ├── js/app.js       # storage / rank logic / render / event wiring
│       └── images/detective.png
├── worker/index.js         # Cloudflare Worker: the sync API + AI proxy
├── schema.sql              # D1 tables
├── migrations/             # one file per schema change, run once each
├── scripts/                # offline checks — no deploy, no API spend
└── README.md
```

## Design notes

- No build step, no framework — plain HTML/CSS/JS so it deploys directly
  to Cloudflare Workers/Pages as static assets.
- `questions.js` holds all content (case files, score categories, rank
  thresholds) separate from `app.js`, which holds all logic. New question
  rounds (e.g. technical) get appended to `CASE_FILES` without touching
  behavior code.
- Progress persists in `localStorage` — client-side only, no backend.
- Color system: dark navy/plum base consistent with the Noir Engine site,
  accent shifted to cool cyan to match this project's character art.

## Adding new questions

Open `public/assets/js/questions.js` and append to `CASE_FILES`:

```js
{ id: 13, category: CASE_CATEGORIES.TECHNICAL, question: "..." },
```

IDs must stay unique and sequential.

## Deploy

`wrangler deploy` ships the Worker and everything in `public/` in one go.
No build step. See "Login & cross-device sync" below for D1 setup.

## Login & cross-device sync

Optional. Signed out, the site behaves exactly as it always did —
everything lives in `localStorage`. Signing in adds a Cloudflare D1
mirror so the same case log follows you between devices.

```
worker/index.js              # API: /api/session, /api/log, /api/access, /api/admin/*
schema.sql                   # D1 tables: detectives, sessions, case_log, invite_codes
public/assets/js/identity.js # client: saved username + the only fetch() calls
```

`Storage` in `app.js` stays synchronous and always answers from
`localStorage`, so the render layer never waits and never handles a
loading state. Sync happens behind it: writes fire a push without
awaiting it, and `Storage.refresh()` folds the server's copy back in on
page load. Every entry carries a client-generated `uid`, which makes the
push idempotent — the whole history can be re-sent any number of times
without duplicating a row.

Passwordless for now. `password_hash` / `password_salt` already exist on
`detectives`, and `Credentials` in the Worker is the single place that
decides whether a login is valid — adding passwords means changing that
module and nothing else.

The login modal has a second, optional field beside the codename. It
carries an invite code for a beta tester or the passphrase for the owner
account — one field, because the person typing it was handed one string
and doesn't need to know there are two mechanisms. Leaving it blank is a
complete and working way to use the site, not a step being skipped. See
[Access tiers](#access-tiers-and-the-spend-cap).

**An invite code is entered once, not every login.** Redeeming it writes
`detectives.access_code`, and later sign-ins use
`COALESCE(?, access_code)` — a blank field leaves the stored code alone
rather than clearing it. So the code belongs to the *codename* from then
on, on every device, and signing in on a phone needs the codename only.
The owner passphrase is the opposite: it is re-checked on every sign-in,
because it is a credential rather than a redemption.

Two consequences worth knowing. Revoking a code takes effect for every
account that redeemed it, immediately, since the tier is re-read from
the codes table on each `/api/coach` call rather than cached on the
session. And because sign-in is still passwordless, anyone who knows a
tester's codename inherits that tester's tier — the codename is the
credential now, and that is the weak link if a code ever needs to be
tightly held.

### First-time setup

```bash
npm install
npx wrangler d1 create interview-case-files   # paste database_id into wrangler.toml
npm run db:init          # create tables locally
npm run db:init:remote   # create tables on Cloudflare
```

### Local dev

```bash
npm run dev              # wrangler dev — Worker + local D1 + static assets
```

### Deploy

```bash
npm run deploy
```

### When login fails

`GET /api/health` answers the three questions worth asking, without an
account and without leaking anything:

```json
{ "ok": true, "db_bound": true, "schema_ready": true,
  "missing_tables": [], "anthropic_key_set": true,
  "owner_passphrase_set": true, "admin_token_set": true }
```

- `db_bound: false` — the `[[d1_databases]]` block is missing or the
  deploy predates it. Fix `wrangler.toml`, redeploy.
- `schema_ready: false` — the binding is fine and the database is empty.
  Run `npm run db:init:remote`. **A `d1 create` makes an empty database;
  the schema is a separate step, and renaming or recreating either the
  Worker or the database does not carry it over.** If `missing_tables`
  lists only some tables, the database predates a schema change — run
  `npm run db:migrate:remote` instead.
- `anthropic_key_set: false` — only the two AI modes are affected, never
  login. Run `npx wrangler secret put ANTHROPIC_API_KEY`. Secrets are
  attached to a Worker *by name*, so a rename leaves them behind.
- `owner_passphrase_set: false` — the `kheera` codename cannot be signed
  in as at all. See [Access tiers](#access-tiers-and-the-spend-cap).
- `admin_token_set: false` — `/api/admin/*` answers 404. Same fix.

`wrangler tail` logs the failing method and path alongside the error.

## AI practice modes

Opening a case card shows a mode picker. It changes only the middle of the
modal — the question above it and the scorecard, bonus box and Close the
Case button below it are identical in all three modes, and the dots stay
manually adjustable no matter which one filled them.

| Mode | What it does | Cost |
| --- | --- | --- |
| Text Practice | Type an answer — or dictate it with the mic button and edit before sending. Claude streams back coaching plus a follow-up and fills the score dots | API |
| Live Voice | The same conversation held out loud, with a glass orb for idle / listening / thinking / speaking. A text box stays open for a typed aside, which is answered out loud like any other turn | API |
| Send to Claude | Copies the question plus a full interviewer prompt to the clipboard. Practise in any Claude session, come back, score by hand | free |

## Access tiers and the spend cap

The two API modes cost real money on every turn, so they are gated. The
manual scorecard, XP, streaks, cross-device sync and Send to Claude are
not — they cost nothing, so gating them would buy nothing.

| Tier | Who | Text Practice / Live Voice | Everything else |
| --- | --- | --- | --- |
| **owner** | codename `kheera` **plus** `OWNER_PASSPHRASE` | unlimited | yes |
| **invited** | any codename **plus** a valid invite code | until that code's cap is spent | yes |
| **free** | any other codename, no code | no — the request is never made | yes |

A free-tier detective who opens Text Practice sees the two modes marked
with a padlock and a line explaining that AI coaching needs an invite
code and that Send to Claude does the same job for nothing. No
`/api/coach` call is made, so the tier costs nothing to refuse.

### Why the owner needs a passphrase

The codename field is free text and creates an account for whatever is
typed into it. Without a secret, `kheera` would not be an identity — it
would be a nine-keystroke bypass of the entire cap system. The passphrase
is checked *before* the row is read or created, so the codename cannot
even be squatted by a stranger signing in first.

`OWNER_PASSPHRASE` unset means nobody can sign in as `kheera` at all.
That is the intended failure: an owner locked out is recoverable, a
codename anyone can type for unlimited API access is not.

### The cap is in dollars, not requests

`invite_codes.spent_usd` holds real money: the token counts Anthropic
reports for each turn, priced against the published per-model rates in
the `Pricing` module of `worker/index.js`. Counting requests would have
been one line and wrong in both directions — a one-line clarifying
question and a full coached answer with a long transcript behind it are
one request each and differ by an order of magnitude.

Four token classes are priced separately because prompt caching is on.
The cached instruction block is ~1,500 tokens that would otherwise be
charged at full input price every turn; read from cache it is a tenth of
that. Pricing cache reads as fresh input would fire the cap roughly ten
times early on exactly the deployment being careful with money.

**Charge first, settle after.** A turn's true cost isn't known until the
model stops talking, so the Worker charges an upper bound before calling
Anthropic and refunds the difference from inside the stream. Doing it the
intuitive way round would mean the cap is only ever checked against turns
that already finished, and a burst of simultaneous requests would all
pass a check none of them had paid for. The single atomic `UPDATE ...
WHERE spent_usd < cap_usd` is what makes exactly one of them the one that
crosses the line.

The gap fails safe: if the browser is closed mid-answer the settle never
runs and the hold stands, so a code can be over-billed by at most one
turn's ceiling and never under-billed. That is why the hold is sized to
the transcript actually being sent rather than to the `MAX_TURNS ×
MAX_CHARS` limit — the theoretical worst case is ~10× a real turn, and
holding it would make an abandoned answer cost ten.

**The pricing table goes stale silently.** It is a hardcoded copy of
[Anthropic's published rates](https://platform.claude.com/docs/en/about-claude/pricing)
(checked 2026-07-28), because a live pricing lookup on the request path
would be a second thing that can fail mid-interview. An unrecognised
`COACH_MODEL` is billed at the most expensive known rate, so a new model
over-spends its cap slightly rather than blowing through it unnoticed.

### Setup

```bash
npx wrangler secret put OWNER_PASSPHRASE   # unlocks the kheera account
npx wrangler secret put ADMIN_TOKEN        # unlocks /api/admin/codes
npm run db:migrate:remote                  # only if the DB predates this feature
```

Locally the same three values go in `.dev.vars` (gitignored) alongside
`ANTHROPIC_API_KEY`.

### Managing invite codes

Day to day, from the site itself: open the login modal and click
**Generate beta code**. That reveals an alternate expanded state of the
same modal, with two operations behind a segmented control:

- **Generate** — a spend cap, and the minted code shown in place.
- **Revoke** — a code to switch off, confirmed with what it had spent.
  Below it, **Revoke all codes**: one sweep across every live code, with
  an arming step first and a count afterwards.

They share the admin token field and nothing else. The panel as a whole
shares no field, no error line and no submit path with signing in, so
nothing typed in one half can affect the other, and it resets itself
every time the modal is opened or closed. The admin token is passed
straight to the request and never stored: not in `localStorage`, not in
a module variable.

### Revoking

Revoking is `active: false` on the existing PATCH route — there is no
separate delete. A revoked code stops working on the **next turn**,
however much of its cap is unspent, because `Access.summary` re-reads it
on every `/api/coach` call rather than trusting the session. It is not
destructive and not a delete:

- `spent_usd` and `turns` survive, so what a code cost stays readable
  after it is switched off.
- The accounts that used it keep their case files, XP and sync. They
  drop to the free tier and lose only the two AI modes.
- It is reversible in one PATCH (`active: true`, or just raise the cap).

That reversibility is why the panel has no "are you sure" dialog —
a confirm step would be guarding an outcome that costs one click to
undo. Revoking a code that was already off reports itself as a no-op
rather than a fresh revocation, so nobody is told they just cut access
that had been cut for a week.

**Revoking everything** is `POST /api/admin/codes/revoke-all`, one
`UPDATE ... WHERE active = 1` rather than a list-then-patch loop in the
browser. A loop would be N round trips that can fail halfway, leaving
some codes off and some on with nothing to say which — and "revoke
everything" is exactly the operation where a partial result is worse
than no result. It answers with how many were *actually* switched off,
so codes already inactive aren't counted, and a second sweep honestly
reports zero.

It is the only action in the panel with a confirmation step. The
single-code revoke names one code and can be undone by name; this one
touches every code at once and leaves no list on screen saying which
they were, so the arming step is the only place to notice. The armed
state does not survive switching tabs or closing the modal.

**Two 404s that mean opposite things.** A bad admin token and an unknown
invite code both answer 404 — the first deliberately, since an admin
route that says "wrong password" has confirmed it exists. Only the
second carries `"reason": "unknown_code"`, so the panel can say which
went wrong without parsing prose, and a bad token still can't be used to
probe for which codes exist.

For scripting, the same three routes take an `x-admin-token` header.

```bash
BASE=https://kheeras-case-method.workers.dev
TOKEN=$ADMIN_TOKEN

# Mint a code (cap defaults to $0.50, hard maximum $100)
curl -sX POST $BASE/api/admin/codes \
  -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"label":"beta: sam","cap_usd":0.50}'
# -> {"code":{"code":"CASE-7F3K-92QX-M4TB","cap_usd":0.5,"spent_usd":0,...}}

# See every code, dearest first
curl -s $BASE/api/admin/codes -H "x-admin-token: $TOKEN"

# Raise a cap — this revives a code that already hit its limit
curl -sX PATCH $BASE/api/admin/codes/CASE-7F3K-92QX-M4TB \
  -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"cap_usd":2.00}'

# Switch one off. spent_usd is untouched, so the history stays readable
curl -sX PATCH $BASE/api/admin/codes/CASE-7F3K-92QX-M4TB \
  -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"active":false}'
# -> {"code":{...,"active":false},"was_active":true}
#    was_active:false means it was already off and nothing changed

# And back on again
curl -sX PATCH $BASE/api/admin/codes/CASE-7F3K-92QX-M4TB \
  -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"active":true}'

# Switch every live code off in one statement
curl -sX POST $BASE/api/admin/codes/revoke-all -H "x-admin-token: $TOKEN"
# -> {"revoked":7}   codes already off aren't counted
```

Or straight at the table, which is the same rows:

```bash
npx wrangler d1 execute interview-case-files --remote \
  --command "SELECT code, label, cap_usd, spent_usd, turns, active FROM invite_codes ORDER BY spent_usd DESC"
```

One row is one budget, not one person: a code handed to three testers
gives them a shared cap, which is the honest shape of the thing being
limited — the API bill does not care who typed the answer. Revoking a
code drops those accounts to the free tier; they keep their case files,
their XP and their sync, and lose only the two AI modes.

### Checking it still holds

```bash
npm run check:access
```

Runs the real Worker against an in-memory SQLite and a stubbed Anthropic
with known token counts, and asserts the behaviour rather than reading
the code back: the owner passphrase is required and the codename can't be
squatted, the free tier is refused without an upstream call, a code stops
at its cap and the arithmetic matches a figure worked out by hand, a
raised cap resumes the session, a revoked code loses AI while it still
has budget left and degrades to free without losing anyone's log, a
second revoke reports itself as a no-op, and the two 404s stay
distinguishable to an admin but not to a stranger. Offline, no API spend.

### The API key never reaches the browser

`Coach` in `worker/index.js` is the only code that reads
`env.ANTHROPIC_API_KEY`, and it is stored as a Worker secret, not in any
file here. The browser POSTs `{ question, messages }` to `/api/coach` and
reads back a stream of exactly two shapes:

```
data: {"text": "..."}    a chunk of coaching prose
data: {"done": true}     the turn is over
```

Anthropic's wire format, the model name and the system prompt all stay
server-side, so there is no request the client can make that returns the
key and nothing to leak if `coach.js` is read in devtools.

`/api/coach` sits behind the same session check as `/api/log`. It is the
one route that spends money per call, so it costs a codename — signed
out, it answers 401 and the modal says so.

### How live voice actually works

The Claude API is text in, text out. There is no audio endpoint to stream
a microphone into and no model that returns speech, so speech-to-speech is
assembled in `coach.js` from three pieces:

1. `Voice` runs continuous browser speech recognition and ends the turn
   after 5s of silence — no push-to-talk. That's far longer than a chat
   app would use, deliberately: this is someone assembling an interview
   answer out loud, and the pause while they work out how to phrase the
   result of a STAR story runs several seconds. A turn that ends late
   costs a few seconds; a turn that ends early costs the answer.
2. `Coach` streams the reply token by token from the Worker.
3. `Speaker` starts talking at the **first finished sentence**, not the
   last, so time-to-first-word stays under a second.

The microphone is closed while `Speaker` talks, otherwise the reply gets
transcribed as if the candidate had said it.

The session and the microphone are separate. Entering the mode attaches
a conversation; the mic button opens listening inside it. A typed aside
is a turn in that same conversation and is answered out loud like any
other — so it works before the mic is ever opened, without triggering a
permission prompt just to ask a clarifying question.

### The microphone picker can report, not command

`SpeechRecognition` has no device parameter. Its whole surface is `lang`,
`continuous`, `interimResults`, `maxAlternatives`, `phrases` and
`processLocally` — there is nowhere to name an input, and the recogniser
takes whatever the browser treats as default.

So the picker in the composer does two honest things: it names the audio
inputs the machine has, and it holds the chosen one open with
`getUserMedia` for the length of a session. In Chrome that usually
steers capture onto that device, because the recogniser attaches to the
live stream — but that is an implementation detail, not a contract.

**If a choice doesn't take, change the default input in your OS sound
settings.** That is the only guaranteed lever, and it's printed at the
foot of the menu rather than left implied — a tooltip on the trigger
goes unread by exactly the person who needs it.

The picker is a caret and a hand-rolled popover, not a `<select>`. A
native select's popup is drawn by the OS, so it can't take the glass
treatment, and its box is sized by the selected option's text — which
put a long device name in the composer and resized the row whenever the
choice changed. The menu is absolutely positioned, so opening it costs
the composer nothing.

Device labels are withheld by `enumerateDevices()` until the page has
been granted a microphone at least once. Unlabelled devices are dropped
rather than numbered, so before the grant the menu holds a single
"System default" row and a line saying where the names went — numbering
anonymous inputs only turns a list nobody can act on into a long list
nobody can act on. After the grant the real names come back for free,
and Chrome remembers it across visits.

The menu is rebuilt every time it opens, so labels upgrade and newly
plugged devices appear without a reload. Opening it never spends a
permission prompt; pressing dictate does, because the prompt is coming
anyway.

The options scroll inside a capped `min(300px, 40vh)`; the caveat below
them stays pinned. A dozen inputs is normal once virtual devices are in
play (Voicemod, Steam, OBS, a headset and its Communications twin all
enumerate separately), and unbounded the menu grew ~450px upward from a
bottom-anchored origin and ran off the top of the modal, where the
scroll container clipped the first entries away.

`Dictation` is a separate module from `Voice` despite driving the same
recogniser. Voice owns turn-taking, synthesis and a conversation with
Coach; Text Practice wants none of that — just words in a box to review
before sending. It also needs less to run: `Voice` requires a speech
*synthesiser*, dictation has nothing to say out loud, so the mic button
works in browsers where full voice practice can't.

`Speaker` is the seam. It drives the browser's own voice today, which
costs nothing and needs no key. Swapping in ElevenLabs means rewriting its
`say` and `stop` to fetch audio through a new Worker route — the sentence
splitting, the queueing and every caller above it stay as they are.

Voice needs `SpeechRecognition`, so it is Chrome/Edge for now. Text
Practice and Send to Claude work in any browser, and the mode picker says
so rather than failing silently.

### Scores ride inside the prose

The model writes its coaching, then a final line:

```
[[SCORES]]{"structure":4,"relevance":4,"clarity":3,"evidence":2,"impact":3}
```

Tool use would have been tidier on paper but forces the client to wait for
a complete JSON block before it can say a word — fatal for voice. The
splitter in `coach.js` holds back the tail of each chunk so a marker torn
across two network reads never reaches the screen or the speaker. Keys the
client doesn't recognise are ignored, so the Worker's rubric and
`SCORE_CATEGORIES` can drift a category apart without either side breaking.

### Why the site lives in `public/`

`[assets] directory` must point at `public/`, never at the repo root.
`wrangler dev` watches that directory recursively and offers no way to
exclude anything — not `.assetsignore`, not a config flag. Pointed at the
root, it watches `.wrangler/`, which local D1 writes to on every request,
so each request triggers a reload that serves another request. Keeping
the served files in their own directory means the watcher only ever sees
files a human edits, and nothing needs an exclusion list.
