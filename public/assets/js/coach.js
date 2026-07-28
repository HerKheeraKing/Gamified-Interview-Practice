/**
 * coach.js
 * ------------------------------------------------------------
 * AI practice: the three ways to work a case.
 *
 * Structure:
 *   1. Coach    - one interviewer turn, streamed. Knows HTTP, not the DOM.
 *   2. Speaker  - turns text into sound. The seam for a better voice.
 *   3. Voice    - mic in, spoken reply out, as a state machine.
 *   4. Handoff  - the no-cost path: a prompt on the clipboard.
 *
 * Loaded before app.js, which is the only consumer. Nothing in here
 * touches the modal, the score dots, or the XP log — app.js decides
 * what to do with what these modules produce.
 *
 * Why no speech-to-speech: the Claude API is text in, text out. There
 * is no audio endpoint to stream a microphone into and no model that
 * returns spoken audio. Real-time voice is therefore assembled here —
 * the browser transcribes continuously, Coach streams the reply token
 * by token, and Speaker starts talking at the first finished sentence
 * rather than waiting for the last one. The latency that matters is
 * time-to-first-word, and that stays under a second.
 * ------------------------------------------------------------
 */

/* ---------------------------------------------------------- */
/* 1. COACH                                                    */
/* ---------------------------------------------------------- */

/**
 * One turn of the interview.
 *
 * `ask` sends the transcript so far and reports back through four
 * callbacks: text as it arrives, grades once they do, then done or
 * failed. Callers get prose and scores as separate things and never
 * learn that they travelled down the same stream.
 *
 * The API key lives in the Cloudflare Worker as a secret. This module
 * cannot read it, and no response it receives contains it.
 */
const Coach = (() => {
  const ENDPOINT = "/api/coach";
  const MARKER = "[[SCORES]]";

  /**
   * @param question  the case question being practised
   * @param messages  [{ role: "user" | "assistant", content }] so far
   * @param on        { text, grades, done, error } — all optional
   */
  async function ask(question, messages, on) {
    const handlers = { text() {}, grades() {}, done() {}, error() {}, ...on };

    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ question, messages }),
      });
    } catch (err) {
      handlers.error("The interviewer is unreachable. Check your connection.");
      return;
    }

    if (!response.ok) {
      handlers.error(await reasonFor(response));
      return;
    }

    const split = splitter();

    try {
      for await (const event of events(response.body)) {
        if (event.text) {
          const visible = split.push(event.text);
          if (visible) handlers.text(visible);
        }
      }
    } catch (err) {
      handlers.error("The interviewer cut out mid-sentence.");
      return;
    }

    const tail = split.finish();
    if (tail.text) handlers.text(tail.text);
    if (tail.grades) handlers.grades(tail.grades);
    handlers.done();
  }

  function headers() {
    const head = { "content-type": "application/json" };
    const token = Identity.token();
    if (token) {
      head.authorization = `Bearer ${token}`;
    }
    return head;
  }

  async function reasonFor(response) {
    if (response.status === 401) {
      return "Sign in with a codename to use AI practice.";
    }
    const body = await response.json().catch(() => ({}));
    return body.error || `The interviewer stumbled (${response.status}).`;
  }

  /** The Worker's stream, one parsed event at a time. */
  async function* events(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          yield JSON.parse(line.slice(5));
        } catch (err) {
          // A malformed frame is worth skipping, not worth dying over.
        }
      }
    }
  }

  /**
   * Separates coaching prose from the scores trailing it.
   *
   * The marker can be torn across two chunks, so the tail of every
   * chunk is held back until enough characters arrive to prove it
   * isn't the start of one. Without that, a stray "[[SCO" reaches the
   * screen — and, worse, gets read aloud.
   */
  function splitter() {
    let all = "";
    let emitted = 0;

    function push(chunk) {
      all += chunk;

      const marker = all.indexOf(MARKER);
      if (marker !== -1) {
        return take(all.slice(0, marker));
      }
      return take(all.slice(0, Math.max(emitted, all.length - MARKER.length + 1)));
    }

    function finish() {
      const marker = all.indexOf(MARKER);
      const prose = marker === -1 ? all : all.slice(0, marker);
      return {
        text: take(prose),
        grades: marker === -1 ? null : parseGrades(all.slice(marker + MARKER.length)),
      };
    }

    function take(visible) {
      const delta = visible.slice(emitted);
      emitted = Math.max(emitted, visible.length);
      return delta;
    }

    return { push, finish };
  }

  /** { structure: 4, ... } or null. Never throws — scores are optional. */
  function parseGrades(tail) {
    const object = tail.match(/\{[^}]*\}/);
    if (!object) return null;
    try {
      const parsed = JSON.parse(object[0]);
      const grades = {};
      for (const [key, value] of Object.entries(parsed)) {
        const score = Math.round(Number(value));
        if (score >= 1 && score <= 5) grades[key] = score;
      }
      return Object.keys(grades).length > 0 ? grades : null;
    } catch (err) {
      return null;
    }
  }

  return { ask };
})();

/* ---------------------------------------------------------- */
/* 2. SPEAKER                                                  */
/* ---------------------------------------------------------- */

/**
 * Text in, sound out.
 *
 * Deliberately the smallest module here, because it is the one most
 * likely to be replaced. Today it drives the browser's own voice,
 * which costs nothing and needs no key. Swapping in ElevenLabs (or
 * anything else) means rewriting `say` and `stop` to fetch audio
 * through a new Worker route and play it — the queueing, the sentence
 * splitting and every caller above stay exactly as they are.
 *
 * `say` resolves when the sentence has finished being spoken, which
 * is what lets Voice hold the microphone closed until then.
 */
const Speaker = (() => {
  const engine = window.speechSynthesis || null;

  function available() {
    return Boolean(engine);
  }

  function say(text) {
    if (!engine || !text.trim()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = preferredVoice();
      utterance.rate = 1.02;
      utterance.pitch = 1.0;
      utterance.onend = resolve;
      // A failed utterance must still resolve, or the caller's queue
      // stalls forever waiting on a voice that never spoke.
      utterance.onerror = resolve;
      engine.speak(utterance);
    });
  }

  function stop() {
    if (engine) engine.cancel();
  }

  /**
   * The nicest English voice this device happens to have. Voice lists
   * are populated asynchronously and differ per OS, so this is a best
   * effort with a documented fallback to the browser default.
   */
  function preferredVoice() {
    const voices = engine.getVoices();
    const english = voices.filter((v) => v.lang.startsWith("en"));
    const liked = ["Google UK English Female", "Samantha", "Microsoft Aria", "Microsoft Zira"];
    for (const name of liked) {
      const match = english.find((v) => v.name.includes(name));
      if (match) return match;
    }
    return english[0] || null;
  }

  return { available, say, stop };
})();

/* ---------------------------------------------------------- */
/* 3. VOICE                                                    */
/* ---------------------------------------------------------- */

/**
 * A spoken conversation, as a four-state machine.
 *
 *   idle → listening → thinking → speaking → listening → …
 *
 * Callers get `onState` and render whatever they like from it; the orb
 * in app.js is one such renderer and could be replaced without this
 * module noticing.
 *
 * Two things make it feel live rather than walkie-talkie:
 *
 *   Turn ends on silence, not on a button. Continuous recognition
 *   keeps a rolling transcript and a short timer decides the candidate
 *   has finished, the same beat a human interviewer waits.
 *
 *   Speaking starts at the first full sentence, not the last. Coach
 *   streams prose in fragments; `absorb` releases them to Speaker one
 *   completed sentence at a time, so the reply begins out loud while
 *   the rest is still being written.
 *
 * The microphone is closed while Speaker talks. Leaving it open means
 * the reply is transcribed as if the candidate had said it.
 */
const Voice = (() => {
  const Recogniser = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const SILENCE_MS = 1400;
  const SENTENCE_END = /([.!?])\s/;

  let session = null;

  function supported() {
    return Boolean(Recogniser && Speaker.available());
  }

  /**
   * Begin a session for one case.
   *
   * @param question  the case question, for Coach's system prompt
   * @param on        { state, heard, said, grades, error }
   */
  function start(question, on) {
    stop();

    session = {
      question,
      on: { state() {}, heard() {}, said() {}, grades() {}, error() {}, ...on },
      messages: [],
      recogniser: null,
      silence: null,
      spoken: Promise.resolve(),
      state: "idle",
    };

    listen();
  }

  /** End the session and release the microphone. */
  function stop() {
    if (!session) return;
    clearTimeout(session.silence);
    quiet();
    Speaker.stop();
    setState("idle");
    session = null;
  }

  /** Send typed text as if it had been spoken — the clarifying-question path. */
  function submit(text) {
    if (!session || !text.trim()) return;
    clearTimeout(session.silence);
    quiet();
    session.on.heard(text);
    respondTo(text);
  }

  function listening() {
    return Boolean(session) && session.state === "listening";
  }

  /* ---- microphone ---- */

  function listen() {
    if (!session) return;

    const recogniser = new Recogniser();
    recogniser.continuous = true;
    recogniser.interimResults = true;
    recogniser.lang = "en-US";

    let heard = "";

    recogniser.onresult = (event) => {
      let interim = "";
      heard = "";
      for (const result of event.results) {
        if (result.isFinal) {
          heard += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      session.on.heard(heard + interim, { partial: true });

      // Every syllable pushes the end of the turn further out; the
      // pause after the last one is what actually ends it.
      clearTimeout(session.silence);
      if ((heard + interim).trim()) {
        session.silence = setTimeout(() => finishTurn(heard + interim), SILENCE_MS);
      }
    };

    recogniser.onerror = (event) => {
      if (event.error === "not-allowed") {
        session.on.error("Microphone access was blocked. Allow it, then try again.");
        stop();
      }
      // "no-speech" and "aborted" are ordinary silence, not failures.
    };

    // Browsers time recognition out on their own; while it's our turn
    // to listen, a restart is the correct response to that.
    recogniser.onend = () => {
      if (session && session.recogniser === recogniser && session.state === "listening") {
        try {
          recogniser.start();
        } catch (err) {
          // Already restarting — harmless.
        }
      }
    };

    session.recogniser = recogniser;
    setState("listening");
    try {
      recogniser.start();
    } catch (err) {
      session.on.error("Couldn't open the microphone.");
    }
  }

  function quiet() {
    if (!session || !session.recogniser) return;
    const recogniser = session.recogniser;
    session.recogniser = null;
    recogniser.onend = null;
    recogniser.stop();
  }

  function finishTurn(transcript) {
    const said = transcript.trim();
    if (!session || !said) return;
    quiet();
    session.on.heard(said);
    respondTo(said);
  }

  /* ---- the reply ---- */

  function respondTo(said) {
    setState("thinking");
    session.messages.push({ role: "user", content: said });

    let reply = "";
    let pending = "";
    let started = false;

    Coach.ask(session.question, session.messages, {
      text(chunk) {
        if (!session) return;
        if (!started) {
          started = true;
          setState("speaking");
        }
        reply += chunk;
        pending = absorb(pending + chunk);
        session.on.said(reply, { partial: true });
      },

      grades(grades) {
        if (session) session.on.grades(grades);
      },

      done() {
        if (!session) return;
        speak(pending);
        pending = "";
        session.messages.push({ role: "assistant", content: reply });
        session.on.said(reply);
        // Listening resumes only once the last sentence is out, so the
        // microphone never hears the interviewer.
        session.spoken.then(() => {
          if (session && session.state === "speaking") listen();
        });
      },

      error(message) {
        if (!session) return;
        session.on.error(message);
        listen();
      },
    });
  }

  /** Speak every complete sentence in `buffer`, return what's left over. */
  function absorb(buffer) {
    let rest = buffer;
    while (true) {
      const boundary = rest.search(SENTENCE_END);
      if (boundary === -1) return rest;
      speak(rest.slice(0, boundary + 1));
      rest = rest.slice(boundary + 2);
    }
  }

  /** Queue a sentence behind the ones already speaking. */
  function speak(text) {
    if (!text.trim()) return;
    session.spoken = session.spoken.then(() => (session ? Speaker.say(text) : undefined));
  }

  function setState(state) {
    if (!session || session.state === state) return;
    session.state = state;
    session.on.state(state);
  }

  return { supported, start, stop, submit, listening };
})();

/* ---------------------------------------------------------- */
/* 4. HANDOFF                                                  */
/* ---------------------------------------------------------- */

/**
 * The free path: practise in a Claude session you're already paying
 * for, and come back to fill the dots by hand.
 *
 * The prompt it writes has to survive being pasted somewhere with no
 * memory of this site, so it carries the question, the rubric and the
 * rules of the exercise in full.
 */
const Handoff = (() => {
  /** True when the prompt reached the clipboard. */
  async function copy(question) {
    const prompt = promptFor(question);
    try {
      await navigator.clipboard.writeText(prompt);
      return true;
    } catch (err) {
      return legacyCopy(prompt);
    }
  }

  function promptFor(question) {
    const rubric = SCORE_CATEGORIES.map((c) => `- ${c.label} — ${c.hint}`).join("\n");

    return [
      "You are running a mock interview with me for a cloud engineering role (AWS, Python).",
      "",
      "The question is:",
      `"${question}"`,
      "",
      "Ask me the question, wait for my answer, then:",
      "1. Give me two to four sentences of specific coaching — what worked, and the",
      "   single highest-value thing to change. No generic praise.",
      "2. Ask one follow-up question a real interviewer would ask next.",
      "3. Score my answer 1–5 in each of these five categories and show it as",
      "   `Category: N/5` on its own line, then the total out of 25:",
      rubric,
      "",
      "Score honestly. A vague answer with no specifics earns 2s, not 4s.",
      "Keep going for as many rounds as I want. Start by asking me the question.",
    ].join("\n");
  }

  /**
   * navigator.clipboard needs a secure context, which `file://` and
   * plain-http previews are not. The old execCommand path still works
   * there, so a local preview doesn't lose the feature.
   */
  function legacyCopy(text) {
    const field = document.createElement("textarea");
    field.value = text;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (err) {
      copied = false;
    }

    document.body.removeChild(field);
    return copied;
  }

  return { copy };
})();
