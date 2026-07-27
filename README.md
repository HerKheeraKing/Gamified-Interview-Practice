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
