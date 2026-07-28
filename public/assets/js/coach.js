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
 *
 * One page, one voice. `voice()` decides which, once, and callers pin
 * what it gives them for the length of a reply — see the comment on it
 * for why choosing per utterance made a single reply audibly change
 * speaker halfway through.
 */
const Speaker = (() => {
  const engine = window.speechSynthesis || null;

  /**
   * Every utterance is set up identically. Left unset, `volume` and
   * `pitch` take engine defaults that aren't guaranteed to match
   * between one utterance and the next, and a reply is spoken as
   * several — so they are stated rather than assumed. A seam between
   * two utterances should be silence, not a change of speaker.
   */
  const RATE = 1.02;
  const PITCH = 1.0;
  const VOLUME = 1.0;

  // How long to wait for the browser to hand over its voice list before
  // speaking without one. Long enough for a list that's coming, short
  // enough not to be heard as a delay. See ready().
  const LIST_WAIT_MS = 400;

  // How often the guard checks whether the engine is actually speaking,
  // and how long an utterance may sit unstarted before it is written off.
  // See the guard in say().
  const GUARD_MS = 250;
  const START_GRACE_MS = 1500;

  // Whether speak() has been reached from a user gesture yet. See unlock().
  let unlocked = false;

  // The last voice reported to the console, so the report happens when
  // the answer changes rather than on every reply. See announce().
  let announced = null;

  function available() {
    return Boolean(engine);
  }

  /**
   * Buy the right to speak later, by speaking now.
   *
   * WebKit will only honour speechSynthesis.speak() if it can trace the
   * call back to a user gesture, and it enforces that by doing nothing
   * at all when it can't: no sound, no error, no `start`, no `end`.
   * Every utterance in this module arrives at the wrong end of a network
   * stream and two promise hops, so on iOS not one of them had a gesture
   * behind it and none of them ever played. That is the whole bug, and
   * it is not a Chrome-vs-Safari matter — every browser on iPad is
   * WebKit underneath, so "it works in Chrome on my laptop" says nothing
   * about the iPad running the same brand.
   *
   * One accepted utterance inside a gesture lifts the restriction for
   * the rest of the page, so this speaks a silent one from the tap that
   * opens the mic. It has to be real text: an empty string is discarded
   * by some engines without ever counting as the call that unlocked
   * anything. `volume = 0` is what keeps it from being heard.
   *
   * Harmless everywhere else — desktop engines simply speak nothing.
   */
  function unlock() {
    if (!engine || unlocked) return;
    unlocked = true;
    try {
      const primer = new SpeechSynthesisUtterance(" ");
      primer.volume = 0;
      engine.speak(primer);
    } catch (err) {
      console.warn("Speech unlock failed:", err);
    }
  }

  /**
   * Speak `text`, resolving when it has finished being spoken.
   *
   * @param on  { spoken(prefix) } — the part of `text` already out loud,
   *            reported as each word starts. Optional: callers that only
   *            want sound can ignore it entirely.
   *
   * The prefix comes from the engine's own boundary events, so it tracks
   * the voice rather than a guess at how fast the voice might be going.
   * Rate changes, a long word, a slow device — the caption follows all
   * of them for free, because it is reading the same clock the sound is.
   *
   * Not every engine emits boundaries (several mobile ones don't). When
   * none arrive the sentence simply reveals whole at `onend`, which is
   * still in step with the speech — just at sentence granularity instead
   * of word. No caller needs to know which kind of engine it got.
   */
  function say(text, on) {
    const handlers = { spoken() {}, voice: undefined, ...on };

    if (!engine || !text.trim()) {
      handlers.spoken(text);
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      // The caller's pinned voice, not a fresh choice — including when
      // they pinned "no voice". An explicit null means the system
      // default was what this reply started with and is what it will
      // finish with; only `undefined`, meaning the caller never had an
      // opinion, falls through to choosing here. Treating null as "ask
      // again" is what let a reply that opened on the default finish on
      // a named voice.
      utterance.voice = handlers.voice === undefined ? voice() : handlers.voice;
      // Stated rather than inherited. WebKit picks its own voice when an
      // utterance has a null voice and no language to go on, and what it
      // picks follows the device locale — an iPad set to Korean reading
      // English coaching aloud in a Korean voice.
      utterance.lang = (utterance.voice && utterance.voice.lang) || "en-GB";
      utterance.rate = RATE;
      utterance.pitch = PITCH;
      utterance.volume = VOLUME;

      let started = false;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(guard);
        // Whatever the boundaries did or didn't say, the sentence is
        // fully spoken now, so the caption ends up whole either way.
        handlers.spoken(text);
        resolve();
      };

      utterance.onboundary = (event) => {
        started = true;
        // Sentence boundaries repeat ground the word events already
        // cover, and would rewind the caption when they do.
        if (event.name && event.name !== "word") return;
        const length = event.charLength || 0;
        handlers.spoken(text.slice(0, event.charIndex + length));
      };

      utterance.onstart = () => { started = true; };
      utterance.onend = finish;
      // A failed utterance must still resolve, or the caller's queue
      // stalls forever waiting on a voice that never spoke.
      utterance.onerror = finish;

      /**
       * The queue cannot be left resting on `end` alone.
       *
       * WebKit skips `end` often enough that treating it as guaranteed
       * is what turned one dropped utterance into a session that never
       * spoke again: `speaking` stayed true, pump() returned early every
       * time after, and the caption — which is only ever written from
       * these same callbacks — stayed empty for the rest of the session.
       * A silent first utterance is a bug; a permanently wedged queue is
       * that bug made unrecoverable.
       *
       * So the engine is asked instead of waited on. Neither speaking
       * nor pending means the utterance is over, whether or not anything
       * said so. The grace period covers the gap between speak() being
       * called and the engine admitting it has work — before that, only
       * a real `start` or `boundary` counts as evidence it began.
       */
      const began = Date.now();
      const guard = setInterval(() => {
        if (done) return;
        if (engine.speaking || engine.pending) {
          started = true;
          return;
        }
        if (started || Date.now() - began > START_GRACE_MS) finish();
      }, GUARD_MS);

      // Safari can leave the queue paused after a cancel() or a trip to
      // the background, and a paused queue accepts utterances without
      // ever playing them. Resuming an unpaused engine does nothing.
      engine.resume();
      engine.speak(utterance);
    });
  }

  function stop() {
    if (engine) engine.cancel();
  }

  /**
   * The voice this page speaks with. The same one every time it's asked.
   *
   * Decided once and remembered, because it used to be decided per
   * utterance and a reply is several utterances. getVoices() returns an
   * empty list until the browser has finished loading it, so the first
   * sentence of a reply was picking from nothing and getting the system
   * default while the third picked from a full list and got a named
   * voice — one reply, two speakers, swapping back and forth at the
   * sentence seams. That is what "the volume and quality keep changing"
   * was.
   *
   * The answer is *not* cached. It used to be — decided once and kept
   * for the life of the page — and that quietly defeated the ranking.
   * Chrome fires `voiceschanged` more than once: the local system
   * voices arrive first and the network voices, which include every
   * Google one, land in a later round. Deciding on the first event
   * meant ranking a list the preferred voice wasn't in yet, settling
   * for the next name down, and never looking again when the real
   * answer turned up milliseconds later. The site asked for a British
   * voice and spoke in an American one for the rest of the session.
   *
   * Consistency was the reason for caching, and it is already handled a
   * layer up: Voice pins this for the length of a reply, so a reply
   * cannot change voice partway through no matter what the list does.
   * Asking again on the next reply is what lets a late-loading voice
   * ever be used at all. The two rules are "the same voice for a whole
   * reply" and "the best available voice at the start of one", and
   * those need different scopes.
   *
   * What's wanted is a British voice. That is a fact about `lang`, so
   * `lang` is what decides, and names only break the tie among voices
   * already known to be British.
   *
   * Ranking by name alone doesn't survive leaving the browser it was
   * written on. The list used to open with Google UK English Female and
   * carry Microsoft Aria a couple of places down as a decent fallback —
   * fine in Chrome, where the first one exists. Edge has no Google
   * voices at all, so the fallback won, and Aria is American. Edge was
   * offering Sonia, Libby and Ryan, all British, all invisible to a
   * ranking that was only looking for four particular names. Every
   * engine spells its voices differently and none of them are the ones
   * this list was written against; `en-GB` means the same thing
   * everywhere.
   *
   * The preferred voices are remote — synthesised on a server, fetched
   * per utterance — which is a real cost: it needs the network, and two
   * utterances are two separate fetches that need not come back at the
   * same loudness. That cost is accepted deliberately, because these
   * are the voices the site is meant to sound like. Consistency within
   * a reply is bought by pinning the choice a layer up and by handing
   * the synthesiser as few utterances as possible, not by picking a
   * voice nobody chose.
   */
  function voice() {
    if (!engine) return null;

    const english = engine.getVoices().filter((v) => isLang(v, "en"));
    if (english.length === 0) return null;

    // British if this machine has one; any English voice if it doesn't,
    // because refusing to speak is not the better outcome.
    const british = english.filter((v) => isLang(v, "en-gb"));
    const pool = british.length > 0 ? british : english;

    return announce(byName(pool, LIKED) || byName(pool, NATURAL) || pool[0], english);
  }

  /**
   * Voices worth having, by the part of the name that identifies them.
   *
   * All British, because this only ever ranks within a British pool
   * when there is one — an American name here would be dead weight at
   * best and, as Microsoft Aria proved, a trap at worst. Chrome's
   * first, then Edge's, then the ones macOS and Windows ship locally.
   */
  const LIKED = [
    "Google UK English Female",
    "Sonia",
    "Libby",
    "Hazel",
    "Kate",
    "Serena",
    "Stephanie",
    "Daniel",
  ];

  // Failing a name we know, take a voice the engine calls "Natural" —
  // Edge and Windows both use that word for their better ones.
  const NATURAL = ["Natural"];

  function isLang(voice, prefix) {
    return Boolean(voice.lang) && voice.lang.toLowerCase().startsWith(prefix);
  }

  /**
   * Say which voice this is, once, whenever the answer changes.
   *
   * Which voice a machine ends up with depends on what it has installed
   * and what has finished loading, so "why does it sound like that" is
   * a question that can only be answered from the machine it sounds
   * wrong on. One console line makes that answerable without a debug
   * build. It reports the accent-carrying facts — the name and whether
   * it came off the network — because those are what the question is
   * usually really about.
   */
  function announce(picked, pool) {
    const name = picked ? picked.name : "the system default";
    if (name === announced) return picked;

    announced = name;
    const where = picked && !picked.localService ? "network" : "on this device";
    console.info(`Live Voice is speaking with: ${name} (${where}).`);
    // The list it was chosen from, alongside the choice. A voice that
    // sounds wrong is nearly always a list that doesn't contain what
    // was expected, and the two are only worth reading together.
    console.info(
      "Live Voice — English voices this browser offers:",
      pool.map((v) => `${v.name} [${v.lang}]`)
    );
    return picked;
  }

  function byName(voices, liked) {
    for (const name of liked) {
      const match = voices.find((v) => v.name.includes(name));
      if (match) return match;
    }
    return null;
  }

  /**
   * Resolves once there is a voice list to choose from, or once it's
   * clear there isn't going to be one.
   *
   * Callers await this before their first utterance so the choice is
   * made from a loaded list rather than an empty one. Warming the list
   * at load time almost always makes this resolve immediately; the wait
   * is for the cold first reply, where the alternative is starting a
   * sentence on the system default and finishing the reply on a named
   * voice.
   *
   * It gives up rather than blocking forever. A device that never
   * answers gets the system default for the whole reply, which is
   * consistent — and consistency is the point, not any particular
   * voice.
   */
  function ready() {
    if (!engine || voice()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        voice();
        resolve();
      };
      const timer = setTimeout(done, LIST_WAIT_MS);
      if (typeof engine.addEventListener === "function") {
        engine.addEventListener("voiceschanged", done);
      }
    });
  }

  return { available, unlock, say, stop, voice, ready };
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
   * Open an input and keep it open for the whole session.
   *
   * This has two jobs, and the second one is why it runs even when no
   * particular device has been chosen.
   *
   * The first is steering: claiming the chosen device usually makes the
   * recogniser attach to it. See the note above for how much that
   * promises.
   *
   * The second is holding the input open *continuously*. A Bluetooth
   * headset has two profiles — a high quality one for playback, and a
   * hands-free one, mono and quieter, that it switches to when the
   * microphone is in use. The operating system picks between them by
   * whether anything is capturing, so every time capture starts or
   * stops the headset renegotiates and what's playing audibly changes
   * character. The recogniser is torn down at the start of every turn,
   * which put one of those renegotiations right in the middle of
   * Claude's reply: it began in one profile and finished in the other.
   * That is what "the volume drops a few seconds in" was, and it only
   * happens on Bluetooth — the same reply through laptop speakers is
   * level throughout.
   *
   * So the page keeps its own claim on the microphone from the moment
   * the session opens until it closes, independent of the recogniser
   * coming and going underneath it. Capture never stops mid-session, so
   * there is never a renegotiation to hear. `mute` covers not listening
   * without letting go.
   *
   * The cost is honest and worth naming: the headset stays in its
   * hands-free profile for the whole session, so Claude's voice is that
   * profile's quality throughout rather than being better for part of a
   * reply and worse for the rest. Consistent is the thing worth having
   * here — a level voice is easy to listen to, one that changes halfway
   * through a sentence is not. The microphone indicator also stays lit
   * while Claude talks, which is honest: the page really is holding the
   * microphone, it just isn't listening through it.
   */
  async function hold() {
    release();
    if (!supported()) {
      return false;
    }

    const id = chosen();
    try {
      held = await media.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
      return true;
    } catch (err) {
      if (id) {
        // Unplugged since it was chosen, most likely. Fall back to the
        // default rather than giving up the claim — holding *some*
        // input open is what keeps the headset from renegotiating, and
        // it matters more than holding the preferred one.
        console.warn("Chosen microphone unavailable:", err.message);
        return holdDefault();
      }
      held = null;
      return false;
    }
  }

  async function holdDefault() {
    try {
      held = await media.getUserMedia({ audio: true });
      return true;
    } catch (err) {
      held = null;
      return false;
    }
  }

  /**
   * Stop listening through the held input without letting go of it.
   *
   * A disabled track delivers silence but stays live, so the device is
   * still claimed and the headset has no reason to change profile. This
   * is the difference between "not listening" and "not holding the
   * microphone", which used to be the same thing and shouldn't be.
   */
  function mute(quiet) {
    if (!held) return;
    held.getAudioTracks().forEach((track) => {
      track.enabled = !quiet;
    });
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

  return { supported, list, chosen, choose, hold, mute, release, onChange };
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

  /**
   * The most text to hand the synthesiser at once, in characters.
   *
   * Roughly twenty seconds of speech. Browsers have a long history of
   * cutting off utterances longer than that and needing a pause/resume
   * poke to keep going, and a reply that goes silent partway is worse
   * than one with a join in it. The join is now inaudible — same voice,
   * same volume, drained the instant the speaker frees up — so this
   * costs nothing to be careful about. See take().
   */
  const MAX_UTTERANCE = 320;

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
      // The speaking side: text waiting to be spoken, whether an
      // utterance is playing, whether Coach has finished sending, what
      // to run when both are done, and the one voice this reply uses.
      queue: "",
      speaking: false,
      streamed: false,
      finished: null,
      voice: undefined,
      state: "idle",
      mic: false,
      // Which turn is currently the live one. See respondTo.
      turn: 0,
      // What Claude has said out loud this turn: `caption` counts whole
      // finished sentences and is what the next one builds onto, `aloud`
      // includes the sentence in progress and is what the candidate has
      // actually heard. See speak().
      caption: "",
      aloud: "",
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
   * box is a quieter way to talk, not a way out of the voice flow, and
   * in particular not a way to cut the interviewer off that the
   * microphone doesn't have. False when there's no conversation to add
   * it to, or when Claude is still using the one there is.
   */
  function submit(text) {
    if (!session || !text.trim() || busy()) return false;
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
    // Muted, not released. The recogniser is gone for the length of the
    // reply but the page keeps the microphone — see Microphones.hold
    // for why letting go here made Claude's voice change character
    // partway through on a Bluetooth headset.
    Microphones.mute(true);
    Speaker.stop();
    session.queue = "";
    session.speaking = false;
    session.streamed = false;
    session.finished = null;
  }

  function listening() {
    return Boolean(session) && session.state === "listening";
  }

  /**
   * True while Claude has the floor.
   *
   * The microphone enforces this on its own — it is closed from the
   * moment a turn starts until the last sentence has been spoken, so
   * there is no way to talk over the interviewer. The text box is the
   * one way in that isn't the microphone, and callers ask this before
   * offering it, so a typed line can't do what a spoken one can't.
   */
  function busy() {
    return Boolean(session) && (session.state === "thinking" || session.state === "speaking");
  }

  /**
   * Cut the reply short and hand the floor back. False when there was
   * nothing to cut.
   *
   * This is the deliberate override, and the only one. The microphone
   * rule doesn't move: it is still shut for the whole of the reply, so
   * no cough, no background voice and no second speaker can end a turn.
   * It takes a press.
   *
   * Cancelling is the turn number's job and needs nothing else.
   * Retiring it orphans the stream still arriving from Coach, the
   * sentences queued behind the one playing, and every callback either
   * of them would have fired — they all find the number moved on and
   * return. `endTurn` silences what is playing right now. There is no
   * flag to unset afterwards and nothing in flight that can land late,
   * which is exactly why the number exists.
   *
   * What Claude actually said aloud goes into the history, not the full
   * reply that arrived. The candidate is answering what they heard, and
   * the transcript should be a record of the conversation they were in.
   */
  function interrupt() {
    if (!session || !busy()) return false;

    const heard = session.aloud.trim();
    session.turn++;
    endTurn();

    if (heard) {
      session.messages.push({ role: "assistant", content: heard });
    }

    if (session.mic) {
      listen();
    } else {
      setState("idle");
    }
    return true;
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
    // The candidate's turn: listening through the input the session has
    // been holding all along.
    Microphones.mute(false);
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
    // The number moves first, so anything still running from the last
    // turn is already superseded when endTurn tears it down and can't
    // mistake this turn's state for its own.
    const turn = ++session.turn;
    const live = () => Boolean(session) && session.turn === turn;
    endTurn();

    session.caption = "";
    session.aloud = "";
    // One voice for the whole reply, pinned by the first utterance and
    // reused by every one after it. Asking per utterance is what made a
    // single reply switch speaker at the sentence joins.
    session.voice = undefined;
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
        // Note what does *not* happen here: the caption is not written
        // from `reply`. See speak() — the words appear at the pace they
        // are spoken, not the pace they arrive.
        pending = absorb(pending + chunk);
      },

      grades(grades) {
        if (live()) session.on.grades(grades);
      },

      done() {
        if (!live()) return;
        enqueue(pending);
        pending = "";
        session.streamed = true;
        // Note where the reply is *not* recorded: here. The stream ends
        // long before the voice does, and a turn stopped in between has
        // to go into the history as the part that was actually heard —
        // which means nothing may be written until the speaking is
        // over and it's known which of the two happened. Recording it
        // on `done` logged the whole reply and then let `interrupt` log
        // the heard part underneath it.
        //
        // The microphone is closed for the whole of the reply and opens
        // again in here, once the queue has drained — which is when the
        // voice stops, not when the text stopped arriving. That is the
        // only path back to listening: nothing the candidate does while
        // Claude is talking can reopen the mic early, and leaving it
        // open would transcribe the interviewer as if it were them.
        //
        // A typed turn with the mic closed still gets spoken — it just
        // falls back to idle afterwards instead of opening a microphone
        // nobody asked for.
        session.finished = () => {
          if (!live()) return;
          // Everything was spoken, so the reply as written is the reply
          // as heard — recorded from `reply` rather than the caption,
          // which loses the original spacing at the joins it was split
          // on.
          session.messages.push({ role: "assistant", content: reply });
          session.on.said(session.aloud);
          if (session.mic) {
            listen();
          } else {
            setState("idle");
          }
        };
        // The queue may already be empty and silent — a reply short
        // enough to have been spoken while the stream finished, or one
        // with nothing in it at all — and nothing else would call this.
        pump();
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

  /** Queue every complete sentence in `buffer`, return what's left over. */
  function absorb(buffer) {
    let rest = buffer;
    while (true) {
      const boundary = rest.search(SENTENCE_END);
      if (boundary === -1) return rest;
      enqueue(rest.slice(0, boundary + 1));
      rest = rest.slice(boundary + 2);
    }
  }

  /** Add finished text to what's waiting to be spoken. */
  function enqueue(text) {
    if (!session || !text.trim()) return;
    session.queue = joined(session.queue, text.trim());
    pump();
  }

  /**
   * Speak what's waiting, if nothing is speaking already.
   *
   * The queue is drained in as few utterances as it can be, not one per
   * sentence. Every utterance is a fresh handoff to the synthesiser, and
   * a reply cut into six of them is six chances for the engine to come
   * back at a different volume or on a different voice — which is what
   * a reply that "changes character halfway through" is made of. One
   * utterance has no seams to hear.
   *
   * Sentences are still released the moment they complete, so the first
   * words come out while the rest of the reply is still being written
   * and time-to-first-word is unchanged. The difference is only in what
   * happens to the sentences behind it: instead of each being handed
   * over on its own, they collect while the current utterance plays and
   * go as one when it ends. A reply typically speaks as two utterances —
   * the opening sentence, then the remainder — with no gap between them,
   * because the queue is drained the instant the speaker frees up.
   *
   * The caption is built from what has actually left the speaker, never
   * from what has arrived from Coach. Those run at wildly different
   * speeds: the stream lands a whole reply in a second or two, while the
   * voice takes twenty to read it.
   */
  function pump() {
    if (!session || session.speaking) return;

    const text = take();
    if (!text) {
      if (session.streamed) settle();
      return;
    }

    const turn = session.turn;
    // Text spoken before this utterance is already captioned and stays
    // put; this one grows onto the end of it.
    const before = session.caption;
    session.speaking = true;

    // Waiting on the voice list only ever happens before the first
    // utterance of the first reply — after that a voice is pinned and
    // this resolves in the same tick. Speaking first and choosing later
    // is what made a reply change speaker mid-way.
    Speaker.ready()
      .then(() => {
        if (!session || session.turn !== turn) return undefined;
        // Pinned once per reply, and `undefined` is the only thing that
        // counts as unpinned. If the list still hadn't loaded when this
        // reply started, the whole reply speaks in the system default
        // rather than changing voice the moment the list turns up.
        if (session.voice === undefined) session.voice = Speaker.voice();

        return Speaker.say(text, {
          // The turn's voice. Every utterance in a reply is the same
          // speaker at the same volume because they are all handed the
          // same one, and `say` never chooses over the top of it.
          voice: session.voice,
          spoken(prefix) {
            if (!session || session.turn !== turn) return;
            session.aloud = joined(before, prefix);
            session.on.said(session.aloud, { partial: true });
          },
        });
      })
      .then(() => {
        // A superseded turn leaves `speaking` alone: endTurn already
        // reset it for whoever came next, and clearing it here would be
        // this turn reaching into theirs.
        if (!session || session.turn !== turn) return;
        session.caption = joined(before, text);
        session.aloud = session.caption;
        session.speaking = false;
        pump();
      });
  }

  /**
   * As much of the queue as one utterance should carry, cut at a
   * sentence end.
   *
   * Uncapped is tempting — one utterance for the whole reply, no seams
   * at all — but engines are known to stop partway through very long
   * ones, and a reply that goes silent is worse than a reply with a
   * join in it. The cap is high enough that a normal coaching reply
   * still speaks as one or two utterances.
   */
  function take() {
    const all = session.queue;
    if (all.length <= MAX_UTTERANCE) {
      session.queue = "";
      return all;
    }

    const ends = [...all.slice(0, MAX_UTTERANCE).matchAll(/[.!?]\s/g)];
    const cut = ends.length > 0 ? ends[ends.length - 1].index + 1 : MAX_UTTERANCE;
    session.queue = all.slice(cut).trim();
    return all.slice(0, cut).trim();
  }

  /**
   * The reply is finished and fully spoken. Runs once — whatever was
   * waiting on the end of the speech is handed the turn and dropped, so
   * a later pump on an empty queue can't run it twice.
   */
  function settle() {
    const done = session.finished;
    session.finished = null;
    if (done) done();
  }

  function joined(before, part) {
    return before ? `${before} ${part}` : part;
  }

  function setState(state) {
    if (!session || session.state === state) return;
    session.state = state;
    session.on.state(state);
  }

  return {
    supported, attached, attach, openMic, closeMic, stop, submit,
    listening, busy, interrupt,
  };
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
