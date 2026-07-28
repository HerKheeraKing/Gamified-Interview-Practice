/**
 * coach.js
 * ------------------------------------------------------------
 * AI practice: the three ways to work a case.
 *
 * Structure:
 *   1. Coach     - one interviewer turn, streamed. Knows HTTP, not the DOM.
 *   2. Speaker   - turns text into sound. The seam for a better voice.
 *   3. Voice     - mic in, spoken reply out, as a state machine.
 *   4. Dictation - mic in, text out. Speaking instead of typing.
 *   5. Handoff   - the no-cost path: a prompt on the clipboard.
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
 * The browser's speech recogniser, shared by the two modules that want
 * it for different reasons: Voice holds a conversation with it, and
 * Dictation below just types with it. Neither owns the constructor,
 * because neither is more entitled to it than the other.
 */
const SpeechEngine = window.SpeechRecognition || window.webkitSpeechRecognition || null;

/**
 * Which microphone is in play.
 *
 * Read this before trusting the picker: SpeechRecognition has no device
 * parameter. Its entire surface is lang, continuous, interimResults,
 * maxAlternatives, phrases and processLocally — there is nowhere to name
 * an input, and the recogniser takes whatever the browser considers the
 * default. No amount of code here changes that.
 *
 * What it can do is `hold` the chosen device open with getUserMedia for
 * the length of a session. In Chrome that usually steers capture onto
 * that device, because the recogniser attaches to the live stream — but
 * that's an implementation detail, not a guarantee, and it can stop
 * being true. So this is honest as *visibility*: it names the inputs the
 * machine has and which one is being requested. When a choice doesn't
 * take, the fix is the OS default, and the UI says so rather than
 * pretending otherwise.
 *
 * Labels are the other wrinkle. enumerateDevices() returns entries with
 * empty labels until the page has been granted a microphone at least
 * once, so an unprimed list is "Microphone 1, 2, 3". `prime` trades a
 * permission prompt for real names, which is why it's only called from
 * places where the detective has already reached for the microphone.
 */
const Microphones = (() => {
  const KEY = "caseFiles.mic.v1";
  const media = navigator.mediaDevices || null;

  let held = null;

  function supported() {
    return Boolean(media && media.enumerateDevices && media.getUserMedia);
  }

  function chosen() {
    try {
      return localStorage.getItem(KEY) || "";
    } catch (err) {
      return "";
    }
  }

  function choose(deviceId) {
    try {
      if (deviceId) {
        localStorage.setItem(KEY, deviceId);
      } else {
        localStorage.removeItem(KEY);
      }
    } catch (err) {
      console.warn("Couldn't remember the microphone choice:", err);
    }
  }

  /**
   * [{ id, label }] for every audio input this page is allowed to name.
   *
   * Devices without labels are dropped rather than numbered. Before
   * permission the browser hands back one anonymous entry per input,
   * and inventing "Microphone 1, 2, 3…" for them turns a list nobody
   * can act on into a long list nobody can act on — the names are the
   * only thing that would make choosing possible. An empty result means
   * "offer the system default and nothing else", which is the honest
   * state until the microphone has been granted once.
   */
  async function list({ prime = false } = {}) {
    if (!supported()) {
      return [];
    }

    if (prime && !(await named())) {
      await grantOnce();
    }

    try {
      const devices = await media.enumerateDevices();
      return devices
        .filter((d) => d.kind === "audioinput" && d.label)
        .map((d) => ({ id: d.deviceId, label: d.label }));
    } catch (err) {
      return [];
    }
  }

  /** True when the browser is already willing to tell us device names. */
  async function named() {
    try {
      const devices = await media.enumerateDevices();
      return devices.some((d) => d.kind === "audioinput" && d.label);
    } catch (err) {
      return false;
    }
  }

  /** Ask for a microphone purely to unlock the labels, then let it go. */
  async function grantOnce() {
    try {
      const stream = await media.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      // Declined. The list stays anonymous, which is a worse UI but not
      // a broken one.
    }
  }

  /**
   * Open the chosen device and keep it open. No-op when the detective
   * hasn't picked one — then the browser default is exactly what's
   * wanted and grabbing a stream would only add a second claim on it.
   */
  async function hold() {
    release();
    const id = chosen();
    if (!id || !supported()) {
      return false;
    }
    try {
      held = await media.getUserMedia({ audio: { deviceId: { exact: id } } });
      return true;
    } catch (err) {
      // Unplugged since it was chosen, most likely. The recogniser still
      // runs on the default, which beats refusing to listen at all.
      console.warn("Chosen microphone unavailable:", err.message);
      held = null;
      return false;
    }
  }

  function release() {
    if (!held) return;
    held.getTracks().forEach((track) => track.stop());
    held = null;
  }

  /** Fires when a device is plugged in or removed. */
  function onChange(handler) {
    if (media && "ondevicechange" in media) {
      media.addEventListener("devicechange", handler);
    }
  }

  return { supported, list, chosen, choose, hold, release, onChange };
})();

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
 *
 * The session and the microphone are separate things. `attach` opens a
 * conversation, `openMic` starts listening in it, and a typed aside is
 * a turn in the same conversation whether the microphone was ever
 * opened or not — the reply is spoken either way, because the point of
 * this mode is to be talked to.
 */
const Voice = (() => {
  /**
   * How long a pause has to run before the turn is treated as over.
   *
   * Deliberately far longer than a chat app would use. This is someone
   * assembling an interview answer out loud, and the pause while they
   * decide how to phrase the result of a STAR story is easily several
   * seconds. Cutting in at a conversational beat teaches them to rush,
   * which is the opposite of the point. A turn that ends late costs a
   * few seconds; a turn that ends early costs the answer.
   */
  const SILENCE_MS = 5000;
  const SENTENCE_END = /([.!?])\s/;

  let session = null;

  function supported() {
    return Boolean(SpeechEngine && Speaker.available());
  }

  function attached() {
    return Boolean(session);
  }

  /**
   * Open a conversation about one case. Does not touch the microphone —
   * typed asides work immediately, and `openMic` adds speech on top.
   *
   * @param question  the case question, for Coach's system prompt
   * @param on        { state, heard, said, grades, error }
   */
  function attach(question, on) {
    stop();

    session = {
      question,
      on: { state() {}, heard() {}, said() {}, grades() {}, error() {}, ...on },
      messages: [],
      recogniser: null,
      silence: null,
      spoken: Promise.resolve(),
      state: "idle",
      mic: false,
      // Which turn is currently the live one. See respondTo.
      turn: 0,
    };
  }

  /** Start listening. The conversation must already be attached. */
  async function openMic() {
    if (!session) return;
    session.mic = true;
    // Claim the chosen input before the recogniser starts, so it has
    // something to attach to. See Microphones for what this does and
    // doesn't promise.
    await Microphones.hold();
    if (session && session.mic) listen();
  }

  /** Stop listening but keep the conversation and its history. */
  function closeMic() {
    if (!session) return;
    session.mic = false;
    // Retiring the turn number orphans any stream still arriving, so a
    // reply that was in flight when the mic closed can't finish speaking
    // into a session the detective has already stepped out of.
    session.turn++;
    endTurn();
    Microphones.release();
    setState("idle");
  }

  /** End the conversation entirely and release the microphone. */
  function stop() {
    if (!session) return;
    closeMic();
    session = null;
  }

  /**
   * Take a typed turn. Same conversation, same spoken reply — the text
   * box is a quieter way to talk, not a way out of the voice flow.
   * False when there's no conversation to add it to.
   */
  function submit(text) {
    if (!session || !text.trim()) return false;
    session.on.heard(text);
    respondTo(text);
    return true;
  }

  /**
   * Everything the previous turn still had running.
   *
   * A turn owns the microphone, a stream from Coach and a queue of
   * sentences waiting to be spoken. Starting the next one without
   * ending all three leaves two interviewers talking over each other,
   * so this is called at the top of every turn rather than trusted to
   * happen on its own.
   */
  function endTurn() {
    clearTimeout(session.silence);
    quiet();
    Speaker.stop();
    session.spoken = Promise.resolve();
  }

  function listening() {
    return Boolean(session) && session.state === "listening";
  }

  /* ---- microphone ---- */

  function listen() {
    if (!session) return;

    const recogniser = new SpeechEngine();
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
        // Close the microphone, not the conversation — typing still works
        // and the history is still worth keeping.
        closeMic();
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

  /**
   * Take the microphone out of the conversation.
   *
   * Every handler comes off, not just `onend`. `stop()` flushes what the
   * recogniser was still holding, and that arrives as one last `onresult`
   * *after* this function returns — which used to re-caption the orb with
   * the candidate's words over the top of Claude's reply and re-arm the
   * silence timer, opening a second turn on the tail of the first. Two
   * turns meant two streams and two voices, the second of them answering
   * a fragment and so sounding like a canned "that wasn't an answer".
   *
   * `abort()` rather than `stop()` for the same reason: there is nothing
   * left to flush that this conversation still wants.
   */
  function quiet() {
    if (!session || !session.recogniser) return;
    const recogniser = session.recogniser;
    session.recogniser = null;
    recogniser.onresult = null;
    recogniser.onerror = null;
    recogniser.onend = null;
    recogniser.abort();
  }

  function finishTurn(transcript) {
    const said = transcript.trim();
    // Only a listening session has a turn to finish. A timer that fired
    // as the state moved on is describing a turn that is already over.
    if (!session || !said || session.state !== "listening") return;
    session.on.heard(said);
    respondTo(said);
  }

  /* ---- the reply ---- */

  /**
   * Answer one thing the candidate said.
   *
   * Each turn takes a number, and every callback below checks it is
   * still the current one before it speaks, scores or captions. There
   * is exactly one voice per turn because a superseded stream finds the
   * number has moved on and returns without touching anything — the
   * tokens are what make a turn cancellable when the candidate types
   * over a reply, or when a stray transcript arrives late.
   */
  function respondTo(said) {
    endTurn();

    const turn = ++session.turn;
    const live = () => Boolean(session) && session.turn === turn;

    setState("thinking");
    session.messages.push({ role: "user", content: said });

    let reply = "";
    let pending = "";
    let started = false;

    Coach.ask(session.question, session.messages, {
      text(chunk) {
        if (!live()) return;
        if (!started) {
          started = true;
          setState("speaking");
        }
        reply += chunk;
        pending = absorb(pending + chunk, turn);
        session.on.said(reply, { partial: true });
      },

      grades(grades) {
        if (live()) session.on.grades(grades);
      },

      done() {
        if (!live()) return;
        speak(pending, turn);
        pending = "";
        session.messages.push({ role: "assistant", content: reply });
        session.on.said(reply);
        // Listening resumes only once the last sentence is out, so the
        // microphone never hears the interviewer. A typed turn with the
        // mic closed still gets spoken — it just falls back to idle
        // afterwards instead of opening a microphone nobody asked for.
        session.spoken.then(() => {
          if (!live() || session.state !== "speaking") return;
          if (session.mic) {
            listen();
          } else {
            setState("idle");
          }
        });
      },

      error(message) {
        if (!live()) return;
        session.on.error(message);
        if (session.mic) {
          listen();
        } else {
          setState("idle");
        }
      },
    });
  }

  /** Speak every complete sentence in `buffer`, return what's left over. */
  function absorb(buffer, turn) {
    let rest = buffer;
    while (true) {
      const boundary = rest.search(SENTENCE_END);
      if (boundary === -1) return rest;
      speak(rest.slice(0, boundary + 1), turn);
      rest = rest.slice(boundary + 2);
    }
  }

  /**
   * Queue a sentence behind the ones already speaking.
   *
   * The turn is checked again when the queue reaches this sentence, not
   * only when it joins: a sentence can wait behind several others, and
   * by the time its turn to be spoken arrives the conversation may have
   * moved on to a newer one.
   */
  function speak(text, turn) {
    if (!text.trim()) return;
    session.spoken = session.spoken.then(() => {
      if (!session || session.turn !== turn) return undefined;
      return Speaker.say(text);
    });
  }

  function setState(state) {
    if (!session || session.state === state) return;
    session.state = state;
    session.on.state(state);
  }

  return { supported, attached, attach, openMic, closeMic, stop, submit, listening };
})();

/* ---------------------------------------------------------- */
/* 4. DICTATION                                                */
/* ---------------------------------------------------------- */

/**
 * Speaking instead of typing. Nothing more.
 *
 * Kept apart from Voice on purpose, even though both drive the same
 * recogniser. Voice owns turn-taking, speech synthesis, and a
 * conversation with Coach; none of that belongs in Text Practice, where
 * the microphone is a convenience and the answer still sits in a box
 * waiting to be read over and edited before it's sent. Folding this
 * into Voice would mean a flag threaded through every one of those
 * behaviours to switch them all off.
 *
 * It also needs less to work: Voice is unavailable without a speech
 * *synthesiser*, but dictation has nothing to say out loud, so it runs
 * in browsers where full voice practice can't.
 *
 * The transcript goes out through a callback rather than being written
 * to a field directly — which element it lands in is the caller's
 * business, and keeping it that way means this never has to know the
 * modal exists.
 */
const Dictation = (() => {
  let recogniser = null;
  // Claiming the microphone is asynchronous, so there's a window where
  // the session exists but the recogniser doesn't. `pending` covers it:
  // without it a second click during that gap starts a rival engine, and
  // `active()` reports "not listening" while the mic is being opened.
  let pending = null;

  function supported() {
    return Boolean(SpeechEngine);
  }

  function active() {
    return Boolean(recogniser || pending);
  }

  /**
   * Start transcribing.
   *
   * @param on  { text(transcript), end(), error(message) }
   *            `text` fires on every revision, including interim ones,
   *            and always carries the whole utterance rather than a
   *            delta — the recogniser rewrites earlier words as later
   *            context arrives, so appending fragments would strand the
   *            corrections it makes.
   */
  async function start(on) {
    stop();
    const handlers = { text() {}, end() {}, error() {}, ...on };

    // Claim the chosen input first — see Microphones for the caveat.
    const token = {};
    pending = token;
    await Microphones.hold();
    if (pending !== token) {
      return; // stopped, or restarted, while the device was opening
    }
    pending = null;

    const engine = new SpeechEngine();
    engine.continuous = true;
    engine.interimResults = true;
    engine.lang = "en-US";

    engine.onresult = (event) => {
      let transcript = "";
      for (const result of event.results) {
        transcript += result[0].transcript;
      }
      handlers.text(transcript.trim());
    };

    engine.onerror = (event) => {
      if (event.error === "not-allowed") {
        handlers.error("Microphone access was blocked. Allow it, then try again.");
      }
    };

    // No auto-restart, unlike Voice. Dictation ends when the speaker
    // stops or clicks the button — there is no turn to hold open.
    engine.onend = () => {
      if (recogniser !== engine) return;
      recogniser = null;
      handlers.end();
    };

    recogniser = engine;
    try {
      engine.start();
    } catch (err) {
      recogniser = null;
      handlers.error("Couldn't open the microphone.");
      handlers.end();
    }
  }

  function stop() {
    pending = null;
    Microphones.release();
    if (!recogniser) return;
    const engine = recogniser;
    recogniser = null;
    engine.onend = null;
    engine.stop();
  }

  return { supported, active, start, stop };
})();

/* ---------------------------------------------------------- */
/* 5. HANDOFF                                                  */
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
