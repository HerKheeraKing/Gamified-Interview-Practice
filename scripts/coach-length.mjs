/**
 * scripts/coach-length.mjs
 * ------------------------------------------------------------
 * Does the interviewer actually keep it short?
 *
 * The brevity instruction is the loudest line in the system prompt, and
 * until it is measured that is all it is — an instruction. This asks the
 * deployed Worker for real coaching on a spread of deliberately awkward
 * answers and counts what comes back.
 *
 * It talks to the deployment, not to Anthropic, so what it measures is
 * the prompt that is actually live rather than the one in the working
 * tree. A mismatch between the two shows up here as a surprise.
 *
 *   node scripts/coach-length.mjs <base-url> <codename>
 *   node scripts/coach-length.mjs https://kheeras-case-method.workers.dev tester
 *
 * The codename is signed in the same way the site signs one in, so this
 * needs no key of its own; the API key stays in the Worker where it
 * belongs. Use a throwaway codename — every run writes a session row.
 * ------------------------------------------------------------
 */

const BUDGET = { sentences: 4, words: 90 };

/**
 * Answers chosen to pull in different directions.
 *
 * A short answer invites the model to fill the silence, a rambling one
 * invites it to summarise what it just heard, and an off-topic one
 * invites it to explain the misunderstanding at length. If brevity
 * survives all three it isn't luck. The strong answer is the control:
 * praise is where replies usually get long.
 */
const QUESTION = "Tell me about a time you reduced cloud costs.";

const ANSWERS = [
  {
    label: "short",
    text: "We moved some things to Lambda and it got cheaper.",
  },
  {
    label: "rambling",
    text:
      "So there was this project, well actually two projects, the second one came " +
      "after the first got shelved, and we had EC2 instances running, quite a few " +
      "of them, I think about thirty, maybe more, and some of them were from before " +
      "I joined so nobody really knew what they did, and there was a spreadsheet " +
      "somewhere that was supposed to track it but it was out of date. Anyway I " +
      "started looking at the bill, and the bill was going up, and my manager asked " +
      "me to look into it, so I did, and I found some instances that were idle, and " +
      "also some snapshots, loads of snapshots going back years. And we had a " +
      "meeting about it and decided to clean it up, which took a while because we " +
      "had to check with people first, and some of them had left the company.",
  },
  {
    label: "off-topic",
    text:
      "I'd say my biggest strength is that I'm a really good team player. I get on " +
      "with everyone and people tend to come to me when they need help with " +
      "something. In my last role I organised the team socials.",
  },
  {
    label: "strong",
    text:
      "Our EC2 bill was 40 percent of infrastructure spend and rising. I pulled " +
      "Cost Explorer data and found 30 dev instances running 24/7 for an 8-hour " +
      "workday. I wrote a Lambda on an EventBridge schedule that tagged and stopped " +
      "anything tagged env=dev outside working hours, with an opt-out tag for the " +
      "two boxes that needed uptime. That cut the dev account by 62 percent, about " +
      "$4,100 a month, and it has held for a year.",
  },
];

const [baseUrl, codename] = process.argv.slice(2);

if (!baseUrl || !codename) {
  console.error("usage: node scripts/coach-length.mjs <base-url> <codename>");
  process.exit(2);
}

const token = await signIn(baseUrl, codename);
const rows = [];

for (const answer of ANSWERS) {
  const reply = await coach(baseUrl, token, QUESTION, answer.text);
  const size = measure(reply.coaching);
  rows.push({ label: answer.label, ...size, scored: Boolean(reply.scores) });

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${answer.label.toUpperCase()}  —  ${size.sentences} sentences, ${size.words} words`);
  console.log("=".repeat(72));
  console.log(reply.coaching.trim());
  console.log(`\n[scores line: ${reply.scores || "MISSING — reply may have been truncated"}]`);
}

console.log(`\n${"=".repeat(72)}\nSUMMARY (budget: ${BUDGET.sentences} sentences / ${BUDGET.words} words)\n${"=".repeat(72)}`);
for (const row of rows) {
  const over = row.sentences > BUDGET.sentences || row.words > BUDGET.words;
  const scored = row.scored ? "" : "  [NO SCORES — truncated?]";
  console.log(
    `${over ? "OVER " : "ok   "} ${row.label.padEnd(10)} ${String(row.sentences).padStart(2)} sentences  ${String(row.words).padStart(3)} words${scored}`
  );
}
const worst = rows.filter((r) => r.sentences > BUDGET.sentences || r.words > BUDGET.words);
console.log(
  worst.length === 0
    ? "\nEvery reply inside budget."
    : `\n${worst.length} of ${rows.length} over budget: ${worst.map((r) => r.label).join(", ")}`
);

/* ---------------------------------------------------------- */

async function signIn(base, username) {
  const response = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!response.ok) {
    throw new Error(`Sign in failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()).token;
}

/** One turn, read to the end. Returns the prose and the scores line. */
async function coach(base, auth, question, said) {
  const response = await fetch(`${base}/api/coach`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body: JSON.stringify({ question, messages: [{ role: "user", content: said }] }),
  });
  if (!response.ok) {
    throw new Error(`Coach failed (${response.status}): ${await response.text()}`);
  }

  let all = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    for (const line of decoder.decode(chunk, { stream: true }).split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const event = JSON.parse(line.slice(5));
        if (event.text) all += event.text;
      } catch (err) {
        // Half a frame. The next chunk carries the rest.
      }
    }
  }

  // The Worker strips the marker on the way out only for the browser's
  // sake; here the raw split is what tells us whether scoring survived.
  const marker = all.indexOf("[[SCORES]]");
  return marker === -1
    ? { coaching: all, scores: null }
    : { coaching: all.slice(0, marker), scores: all.slice(marker).trim() };
}

/**
 * Sentence and word counts.
 *
 * Sentences are counted on terminal punctuation followed by whitespace
 * or end of text, which miscounts an abbreviation and is close enough:
 * the question is whether a reply is two sentences or nine, and nothing
 * about that turns on one decimal point.
 */
function measure(text) {
  const trimmed = text.trim();
  const sentences = (trimmed.match(/[.!?](\s|$)/g) || []).length;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return { sentences, words, chars: trimmed.length };
}
