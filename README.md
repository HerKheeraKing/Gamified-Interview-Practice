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
| Text Practice | Type an answer — or dictate it with the mic button and edit before sending. Claude streams back coaching plus a follow-up and fills the score dots | API |
| Live Voice | The same conversation held out loud, with a glass orb for idle / listening / thinking / speaking. A text box stays open for a typed aside, which is answered out loud like any other turn | API |
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
been granted a microphone at least once, so the list reads "Microphone
1, 2" only until the first grant — after that the real names come back
for free, and Chrome remembers the grant across visits. The menu is
rebuilt every time it opens, so labels upgrade and newly plugged devices
appear without a reload. Opening it never spends a permission prompt;
pressing dictate does, because the prompt is coming anyway.

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
