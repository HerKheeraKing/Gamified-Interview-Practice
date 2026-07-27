# The Interview Case Files

A gamified interview-practice tracker. Detective/RPG themed — behavioral
questions now, technical questions added in future rounds.

## Structure

```
.
├── index.html              # single-page app shell
├── assets/
│   ├── css/style.css       # design tokens + all styling
│   ├── js/questions.js     # question bank + rank data (content, no logic)
│   ├── js/app.js           # storage / rank logic / render / event wiring
│   └── images/detective.png
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

Open `assets/js/questions.js` and append to `CASE_FILES`:

```js
{ id: 13, category: CASE_CATEGORIES.TECHNICAL, question: "..." },
```

IDs must stay unique and sequential.

## Deploy

Static site — point Cloudflare Pages/Workers at this folder, `index.html`
as the entry point. No env vars, no build command needed.

## Login & cross-device sync

Optional. Signed out, the site behaves exactly as it always did —
everything lives in `localStorage`. Signing in adds a Cloudflare D1
mirror so the same case log follows you between devices.

```
worker/index.js       # API: /api/session, /api/log (GET/POST/DELETE)
schema.sql            # D1 tables: detectives, sessions, case_log
assets/js/identity.js # client: saved username + the only fetch() calls
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

`.assetsignore` keeps `worker/`, `schema.sql` and config out of what
gets served publicly.
