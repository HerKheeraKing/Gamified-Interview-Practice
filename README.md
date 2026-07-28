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
worker/index.js              # API: /api/session, /api/log (GET/POST/DELETE)
schema.sql                   # D1 tables: detectives, sessions, case_log
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

## AI practice modes

Opening a case card shows a mode picker. It changes only the middle of the
modal — the question above it and the scorecard, bonus box and Close the
Case button below it are identical in all three modes, and the dots stay
manually adjustable no matter which one filled them.

| Mode | What it does | Cost |
| --- | --- | --- |
| Text Practice | Type an answer, Claude streams back coaching plus a follow-up and fills the score dots | API |
| Live Voice | The same conversation held out loud, with a glass orb for idle / listening / thinking / speaking. A text box stays open for a typed aside without breaking voice flow | API |
| Send to Claude | Copies the question plus a full interviewer prompt to the clipboard. Practise in any Claude session, come back, score by hand | free |

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

1. `Voice` runs continuous browser speech recognition and ends the turn on
   ~1.4s of silence, the same beat an interviewer waits — no push-to-talk.
2. `Coach` streams the reply token by token from the Worker.
3. `Speaker` starts talking at the **first finished sentence**, not the
   last, so time-to-first-word stays under a second.

The microphone is closed while `Speaker` talks, otherwise the reply gets
transcribed as if the candidate had said it.

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
