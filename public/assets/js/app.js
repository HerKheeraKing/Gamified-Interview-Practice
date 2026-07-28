/**
 * app.js
 * ------------------------------------------------------------
 * Case Files interview practice tracker.
 *
 * Structure:
 *   1. Storage layer   - persistence, no DOM/UI knowledge
 *   2. Rank logic       - pure functions, no side effects
 *   3. Render layer     - DOM writes only, reads state, no calculations
 *   4. Score modal      - the scorecard, and the only owner of the dots
 *   5. Practice modes   - the middle of that modal: text, voice, handoff
 *   6+ Event wiring     - glues user actions to state + render
 *
 * Kept intentionally framework-free and single-file per concern
 * so the whole thing stays readable without a build step.
 * ------------------------------------------------------------
 */

/* ---------------------------------------------------------- */
/* 1. STORAGE LAYER                                            */
/* ---------------------------------------------------------- */

/**
 * The log, and everything it takes to keep it.
 *
 * getLog() stays synchronous and always answers from localStorage, so
 * the render layer never waits, never handles a loading state, and reads
 * identically whether the detective is signed in or not. Cloudflare is a
 * background concern hidden entirely inside this module: writes fire off
 * a push and don't await it, and `refresh()` folds the server's copy back
 * into the cache when it eventually arrives.
 *
 * Every entry carries a `uid`, which is what makes the merge safe — the
 * server ignores uids it already holds, so pushing the whole history
 * repeatedly costs nothing and duplicates nothing.
 */
const Storage = (() => {
  const KEY = "caseFiles.log.v1";

  function getLog() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw).map(withUid) : [];
    } catch (err) {
      console.error("Storage read failed:", err);
      return [];
    }
  }

  function saveEntry(entry) {
    const log = getLog();
    log.push(withUid(entry));
    write(log);
    Api.pushLog(log).then(adopt);
    return log;
  }

  function clearLog() {
    localStorage.removeItem(KEY);
    Api.clearLog();
  }

  /**
   * Reconcile with the server: push whatever is local, keep whatever
   * comes back. Resolves to true when the cache actually changed, so
   * the caller knows whether a re-render is worth doing.
   */
  async function refresh() {
    const local = getLog();
    const remote = await (local.length > 0 ? Api.pushLog(local) : Api.pullLog());
    return adopt(remote);
  }

  /** Replace the cache with a server log. False when there's nothing to take. */
  function adopt(remote) {
    if (!remote) {
      return false;
    }
    const before = localStorage.getItem(KEY);
    const after = JSON.stringify(remote);
    if (before === after) {
      return false;
    }
    write(remote);
    return true;
  }

  function write(log) {
    try {
      localStorage.setItem(KEY, JSON.stringify(log));
    } catch (err) {
      console.error("Storage write failed:", err);
    }
  }

  /** Backfills entries written before sync existed. */
  function withUid(entry) {
    if (entry.uid) {
      return entry;
    }
    return {
      ...entry,
      uid: `${entry.caseId}-${entry.loggedAt || entry.date}-${Math.random().toString(36).slice(2, 10)}`,
      loggedAt: entry.loggedAt || new Date().toISOString(),
    };
  }

  return { getLog, saveEntry, clearLog, refresh };
})();

/* ---------------------------------------------------------- */
/* 2. RANK LOGIC (pure)                                        */
/* ---------------------------------------------------------- */

const RankEngine = (() => {
  function totalXp(log) {
    return log.reduce((sum, entry) => sum + entry.xp, 0);
  }

  function currentRank(xp) {
    let rank = RANKS[0];
    for (const r of RANKS) {
      if (xp >= r.min) rank = r;
    }
    return rank;
  }

  function nextRank(xp) {
    return RANKS.find((r) => r.min > xp) || null;
  }

  function progressPercent(xp) {
    const rank = currentRank(xp);
    const next = nextRank(xp);
    if (!next) return 100;
    const span = next.min - rank.min;
    const progressed = xp - rank.min;
    const pct = Math.round((progressed / span) * 100);
    // Always show a small glowing sliver so the bar never reads as
    // empty/broken right at a rank boundary (0% into a new rank).
    return Math.min(100, Math.max(4, pct));
  }

  return { totalXp, currentRank, nextRank, progressPercent };
})();

/* ---------------------------------------------------------- */
/* 3. RENDER LAYER                                              */
/* ---------------------------------------------------------- */

const Render = (() => {
  let activeRound = 1;

  function roundCarousel() {
    const track = document.getElementById("round-track");
    const dots = document.getElementById("round-dots");

    // Build the sliding track (one slide per round)
    track.innerHTML = `
      <div class="round-track-inner" id="round-track-inner">
        ${ROUNDS.map((r) => {
          const count = CASE_FILES.filter((c) => c.round === r.id).length;
          return `
            <div class="round-slide">
              <div class="round-slide-card">
                <div class="round-slide-label">
                  <span class="r-num">${r.title.toUpperCase()}</span>
                  <span class="r-title">${r.subtitle}</span>
                </div>
                <div class="round-slide-count">
                  ${count > 0 ? `${count} case${count === 1 ? "" : "s"} filed` : "No cases yet"}
                </div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;

    // Build the dots
    dots.innerHTML = ROUNDS.map((r) => `
      <button type="button" class="round-dot ${r.id === activeRound ? "active" : ""}" data-round-id="${r.id}" aria-label="${r.title}"></button>
    `).join("");

    positionTrack();
    wireCarousel();
  }

  function positionTrack() {
    const inner = document.getElementById("round-track-inner");
    if (!inner) return;
    const index = ROUNDS.findIndex((r) => r.id === activeRound);
    inner.style.transform = `translateX(-${index * 100}%)`;

    document.querySelectorAll(".round-dot").forEach((dot) => {
      dot.classList.toggle("active", Number(dot.dataset.roundId) === activeRound);
    });
  }

  function goToRound(roundId) {
    activeRound = roundId;
    positionTrack();
    caseGrid();
    updateSubtitle();
  }

  function updateSubtitle() {
    const round = ROUNDS.find((r) => r.id === activeRound);
    document.getElementById("round-subtitle").textContent =
      `${round.subtitle} — ${round.title}`;
  }

  function wireCarousel() {
    // Dot clicks
    document.querySelectorAll(".round-dot").forEach((dot) => {
      dot.addEventListener("click", () => goToRound(Number(dot.dataset.roundId)));
    });

    // Drag / swipe
    const track = document.getElementById("round-track");
    let startX = 0;
    let dragging = false;

    const onStart = (x) => { startX = x; dragging = true; };
    const onEnd = (x) => {
      if (!dragging) return;
      dragging = false;
      const dx = x - startX;
      const threshold = 50;
      const idx = ROUNDS.findIndex((r) => r.id === activeRound);
      if (dx < -threshold && idx < ROUNDS.length - 1) {
        goToRound(ROUNDS[idx + 1].id);
      } else if (dx > threshold && idx > 0) {
        goToRound(ROUNDS[idx - 1].id);
      }
    };

    track.addEventListener("mousedown", (e) => onStart(e.clientX));
    track.addEventListener("mouseup", (e) => onEnd(e.clientX));
    track.addEventListener("mouseleave", (e) => { if (dragging) onEnd(e.clientX); });
    track.addEventListener("touchstart", (e) => onStart(e.touches[0].clientX), { passive: true });
    track.addEventListener("touchend", (e) => onEnd(e.changedTouches[0].clientX));
  }

  function rankPanel() {
    const log = Storage.getLog();
    const xp = RankEngine.totalXp(log);
    const rank = RankEngine.currentRank(xp);
    const next = RankEngine.nextRank(xp);
    const pct = RankEngine.progressPercent(xp);

    document.getElementById("xp-total").textContent = xp;
    document.getElementById("rank-title").textContent = rank.title;
    document.getElementById("rank-level").textContent = `LVL ${rank.level}`;
    document.getElementById("xp-bar-fill").style.width = `${pct}%`;
    document.getElementById("xp-current-label").textContent = `${xp} XP`;
    document.getElementById("xp-next-label").textContent = next
      ? `${next.min - xp} XP to ${next.title}`
      : "Max rank reached";
  }

  function caseGrid() {
    const grid = document.getElementById("case-grid");
    const log = Storage.getLog();
    const round = ROUNDS.find((r) => r.id === activeRound);

    updateSubtitle();

    const casesInRound = CASE_FILES.filter((c) => c.round === activeRound);

    if (casesInRound.length === 0) {
      grid.innerHTML = `
        <div class="case-grid-empty">
          No cases filed for this round yet.<br />
          Add ${round.subtitle.toLowerCase()} questions to <code>questions.js</code> whenever you're ready to drill this round.
        </div>
      `;
      return;
    }

    grid.innerHTML = casesInRound.map((c) => {
      const attempts = log.filter((e) => e.caseId === c.id);
      const timesLogged = attempts.length;
      const best = timesLogged ? Math.max(...attempts.map((e) => e.xp)) : null;
      const latest = timesLogged ? attempts[attempts.length - 1].xp : null;

      const scoreBadge = timesLogged
        ? `
          <div class="case-score">
            <div class="case-score-best">
              <span class="cs-num">${best}</span>
              <span class="cs-label">best</span>
            </div>
            <div class="case-score-latest">
              <span class="cs-num-sm">${latest}</span>
              <span class="cs-label">last</span>
            </div>
          </div>
        `
        : `<div class="case-score case-score-empty"><span class="cs-label">not yet practiced</span></div>`;

      return `
        <button class="case-card" data-case-id="${c.id}">
          <span class="case-num">#${String(c.id).padStart(2, "0")}</span>
          <span class="case-q">${c.question}</span>
          ${scoreBadge}
        </button>
      `;
    }).join("");
  }

  function logTable() {
    const tbody = document.getElementById("log-tbody");
    const log = Storage.getLog().slice().reverse();

    if (log.length === 0) {
      tbody.innerHTML = `<tr class="log-empty-row"><td colspan="4">No cases logged yet. Go crack one open.</td></tr>`;
      return;
    }

    tbody.innerHTML = log.map((entry) => `
      <tr>
        <td>${entry.date}</td>
        <td>#${String(entry.caseId).padStart(2, "0")} — ${entry.questionShort}</td>
        <td>${entry.rawScore}/25${entry.bonus ? " +5" : ""}</td>
        <td>${entry.xp} XP</td>
      </tr>
    `).join("");
  }

  function all() {
    rankPanel();
    roundCarousel();
    caseGrid();
    logTable();
  }

  return { rankPanel, roundCarousel, caseGrid, logTable, all };
})();

/* ---------------------------------------------------------- */
/* 4. MODAL / SCORING FLOW                                     */
/* ---------------------------------------------------------- */

const ScoreModal = (() => {
  let activeCase = null;
  const scores = {};

  function open(caseId) {
    activeCase = CASE_FILES.find((c) => c.id === caseId);
    if (!activeCase) return;

    SCORE_CATEGORIES.forEach((cat) => (scores[cat.key] = 0));
    document.getElementById("bonus-check").checked = false;

    document.getElementById("modal-case-num").textContent = `CASE FILE #${String(activeCase.id).padStart(2, "0")}`;
    document.getElementById("modal-question").textContent = activeCase.question;

    renderFields();
    updateTotal();
    Practice.reset(activeCase.question);

    document.getElementById("case-modal-backdrop").classList.add("open");
  }

  function close() {
    document.getElementById("case-modal-backdrop").classList.remove("open");
    Practice.reset(null);
    activeCase = null;
  }

  /**
   * Fill the dots from a set of Claude's grades.
   *
   * Unknown keys are ignored rather than rejected, so the Worker's
   * rubric and this one can drift a category apart without either
   * side breaking. Whatever lands here is still only a suggestion —
   * the dots stay clickable and the detective has the last word.
   */
  function applyGrades(grades) {
    let applied = false;
    for (const [key, value] of Object.entries(grades)) {
      if (key in scores) {
        scores[key] = value;
        paint(key);
        applied = true;
      }
    }
    if (applied) updateTotal();
  }

  function renderFields() {
    const container = document.getElementById("score-fields");
    container.innerHTML = SCORE_CATEGORIES.map((cat) => `
      <div class="score-field" data-key="${cat.key}">
        <div class="score-field-label">
          <span>${cat.label}</span>
          <span class="score-field-hint">${cat.hint}</span>
        </div>
        <div class="score-dots" data-key="${cat.key}">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="dot" data-value="${n}">${n}</button>`).join("")}
        </div>
      </div>
    `).join("");

    container.querySelectorAll(".score-dots").forEach((group) => {
      const key = group.dataset.key;
      group.querySelectorAll(".dot").forEach((dot) => {
        dot.addEventListener("click", () => {
          scores[key] = Number(dot.dataset.value);
          paint(key);
          updateTotal();
        });
      });
    });
  }

  /** Light one category's dots up to its current score. */
  function paint(key) {
    const group = document.querySelector(`.score-dots[data-key="${key}"]`);
    if (!group) return;
    group.querySelectorAll(".dot").forEach((dot) => {
      dot.classList.toggle("selected", Number(dot.dataset.value) <= scores[key]);
    });
  }

  function rawScore() {
    return Object.values(scores).reduce((a, b) => a + b, 0);
  }

  function updateTotal() {
    const bonus = document.getElementById("bonus-check").checked ? 5 : 0;
    document.getElementById("modal-total-xp").textContent = rawScore() + bonus;
  }

  function submit() {
    if (!activeCase) return;
    const bonus = document.getElementById("bonus-check").checked;
    const raw = rawScore();
    const xp = raw + (bonus ? 5 : 0);

    const now = new Date();
    const entry = {
      uid: crypto.randomUUID(),
      caseId: activeCase.id,
      questionShort: activeCase.question.slice(0, 40) + (activeCase.question.length > 40 ? "…" : ""),
      date: now.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
      loggedAt: now.toISOString(),
      rawScore: raw,
      bonus,
      xp,
    };

    Storage.saveEntry(entry);
    close();
    Render.all();
  }

  return { open, close, submit, applyGrades, updateTotal };
})();

/* ---------------------------------------------------------- */
/* 5. PRACTICE MODES                                            */
/* ---------------------------------------------------------- */

/**
 * The middle of the case modal.
 *
 * Three ways to work the same question, and one rule that keeps them
 * from tangling: this module owns the space between the question and
 * the scorecard, and nothing else. The case number above it and the
 * dots, bonus box and Close the Case button below it are identical in
 * every mode and are never touched here — the only thing Practice ever
 * says to the rest of the app is `ScoreModal.applyGrades(...)`.
 *
 * Two of the modes talk to Claude and one deliberately doesn't:
 *
 *   text     typed answers, streamed coaching, dots filled for you
 *   voice    the same conversation held out loud, orb instead of chat
 *   handoff  a prompt on the clipboard, practise elsewhere, score by hand
 *
 * `reset` is the single entry point for both opening and closing —
 * passing a question starts fresh, passing null tears down. Every
 * escape route out of the modal (button, backdrop, Escape, closing the
 * case) funnels through it, which is what guarantees the microphone
 * is never left open behind a modal that isn't on screen.
 */
const Practice = (() => {
  const STAGES = { text: "stage-text", voice: "stage-voice", handoff: "stage-handoff" };

  let question = null;
  let mode = null;
  let transcript = [];
  let waiting = false;
  let live = false;

  function init() {
    document.getElementById("practice-modes").addEventListener("click", (e) => {
      const button = e.target.closest(".practice-mode");
      if (button) choose(button.dataset.mode);
    });

    document.getElementById("practice-send").addEventListener("click", send);

    const input = document.getElementById("practice-input");
    input.addEventListener("input", fitInput);
    input.addEventListener("keydown", (e) => {
      // Enter sends, as it did when this was a single-line field.
      // Shift+Enter is the escape hatch now that a line break is
      // something the box can actually hold.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    document.getElementById("practice-mic").addEventListener("click", toggleDictation);
    document.getElementById("voice-toggle").addEventListener("click", toggleVoice);
    document.getElementById("handoff-copy").addEventListener("click", copyPrompt);
  }

  /** Start a fresh session for `question`, or tear everything down with null. */
  function reset(nextQuestion) {
    endVoice();
    endDictation();
    question = nextQuestion;
    mode = null;
    transcript = [];
    waiting = false;

    document.getElementById("practice-panel").hidden = true;
    document.getElementById("chat-log").innerHTML = "";
    document.getElementById("practice-input").value = "";
    fitInput();
    document.getElementById("handoff-status").textContent = "";
    document.querySelectorAll(".practice-mode").forEach((b) => b.classList.remove("active"));
  }

  /* ---- mode switching ---- */

  function choose(next) {
    if (mode === next) {
      reset(question);
      return;
    }

    endVoice();
    endDictation();
    mode = next;
    waiting = false;

    document.querySelectorAll(".practice-mode").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });

    Object.entries(STAGES).forEach(([name, id]) => {
      document.getElementById(id).hidden = name !== mode;
    });

    document.getElementById("practice-composer").hidden = mode === "handoff";
    document.getElementById("practice-panel").hidden = false;
    document.getElementById("practice-input").placeholder =
      mode === "voice" ? "Or type a quick question…" : "Type your answer and hit enter";

    // Dictation is a Text Practice convenience. Live Voice already has a
    // microphone, and a second one next to it would be two buttons doing
    // visibly different things with the same icon.
    document.getElementById("practice-mic").hidden =
      mode !== "text" || !Dictation.supported();

    // Voice mode opens the conversation immediately but not the
    // microphone — a typed aside is a valid first turn, and it shouldn't
    // have to trigger a permission prompt to be heard.
    if (mode === "voice" && Voice.supported()) {
      Voice.attach(question, voiceHandlers());
    }

    note(openingNote());

    // Asking the log whether it's empty rather than the transcript:
    // leaving text mode and coming back re-runs this, and the transcript
    // being empty doesn't mean the hint isn't already on screen. Only
    // `reset` clears the log, so this seeds exactly once per case.
    //
    // "hint", not "assistant" — it's an instruction to the room, not a
    // turn in the conversation, so it centres instead of sitting in a
    // bubble on Claude's side.
    if (mode === "text" && !document.getElementById("chat-log").hasChildNodes()) {
      say("hint", "Whenever you're ready — answer the question above and I'll score it.");
    }
  }

  /**
   * What to warn about before the detective starts talking to a wall.
   * Both AI modes cost money, so both need a codename; voice also
   * needs browser support the site can't provide itself.
   */
  function openingNote() {
    if (mode === "handoff") {
      return "";
    }
    if (!Identity.isSignedIn()) {
      return "Sign in with a codename first — AI practice runs through your Cloudflare Worker.";
    }
    if (mode === "voice" && !Voice.supported()) {
      return "This browser has no speech engine. Chrome or Edge will do it; Text Practice works anywhere.";
    }
    return "";
  }

  function note(message) {
    const element = document.getElementById("practice-note");
    element.textContent = message;
    element.hidden = !message;
  }

  /**
   * Match the answer box's height to its contents.
   *
   * Called from the `input` event and from everywhere the value is set
   * in code — dictation rewriting the transcript, send() clearing it,
   * reset() emptying it. Programmatic assignment doesn't fire `input`,
   * so a box filled by the microphone would otherwise stay one line
   * tall and hide the very text the mic button exists to produce.
   *
   * Collapsing to `auto` first is what allows it to shrink again; read
   * against a fixed height, scrollHeight can only ever grow.
   */
  function fitInput() {
    const input = document.getElementById("practice-input");
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  /* ---- text mode ---- */

  function send() {
    const input = document.getElementById("practice-input");
    const said = input.value.trim();
    if (!said || waiting) return;

    // Dictating and then sending shouldn't leave the microphone running
    // over the top of the reply.
    endDictation();

    // In voice mode the composer is a side channel into the same
    // conversation, so Voice takes it and answers out loud. It only
    // declines when there's no conversation to add to — an unsupported
    // browser — and that has to be said rather than swallowed.
    if (mode === "voice") {
      if (Voice.submit(said)) {
        input.value = "";
        fitInput();
      } else {
        note(openingNote() || "Live Voice needs a browser with a speech engine — try Chrome or Edge.");
      }
      return;
    }

    input.value = "";
    fitInput();
    say("user", said);
    transcript.push({ role: "user", content: said });
    ask();
  }

  function ask() {
    waiting = true;
    const bubble = say("assistant", "");
    let reply = "";

    Coach.ask(question, transcript, {
      text(chunk) {
        reply += chunk;
        bubble.textContent = reply;
        scrollChat();
      },
      grades: ScoreModal.applyGrades,
      done() {
        waiting = false;
        transcript.push({ role: "assistant", content: reply });
        scrollChat();
      },
      error(message) {
        waiting = false;
        bubble.textContent = message;
        bubble.parentElement.classList.add("chat-error");
        scrollChat();
      },
    });
  }

  /** Append a bubble and hand back its text node for streaming into. */
  function say(who, text) {
    const log = document.getElementById("chat-log");
    const row = document.createElement("div");
    row.className = `chat-row chat-${who}`;

    const bubble = document.createElement("p");
    bubble.className = "chat-bubble";
    bubble.textContent = text;

    row.appendChild(bubble);
    log.appendChild(row);
    scrollChat();
    return bubble;
  }

  function scrollChat() {
    const log = document.getElementById("chat-log");
    log.scrollTop = log.scrollHeight;
  }

  /* ---- voice mode ---- */

  function voiceHandlers() {
    return {
      state(state) {
        setOrb(state, LABELS[state], null);
      },
      heard(text) {
        setOrb(null, null, text);
      },
      said(text) {
        setOrb(null, null, text);
      },
      grades: ScoreModal.applyGrades,
      error: note,
    };
  }

  /**
   * Opens and closes the microphone, not the conversation. `choose`
   * already attached one, so a typed aside works before this is ever
   * clicked and the history survives closing the mic again.
   */
  function toggleVoice() {
    if (live) {
      endVoice();
      return;
    }

    if (!Identity.isSignedIn() || !Voice.supported()) {
      note(openingNote());
      return;
    }

    if (!Voice.attached()) {
      Voice.attach(question, voiceHandlers());
    }

    live = true;
    document.getElementById("voice-toggle").textContent = "End the session";
    Voice.openMic();
  }

  function endVoice() {
    live = false;
    Voice.stop();
    setOrb("idle", LABELS.idle, "");
    document.getElementById("voice-toggle").textContent = "Open the mic";
  }

  const LABELS = {
    idle: "Mic closed",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking",
  };

  /** Null for state or caption means "leave that one alone". */
  function setOrb(state, label, caption) {
    if (state !== null) {
      document.getElementById("orb").dataset.state = state;
    }
    if (label !== null && label !== undefined) {
      document.getElementById("orb-state").textContent = label;
    }
    if (caption !== null && caption !== undefined) {
      document.getElementById("orb-caption").textContent = caption;
    }
  }

  /* ---- dictation (text mode) ---- */

  /**
   * Speaking into the answer box.
   *
   * Whatever was already typed is held as a prefix and the transcript is
   * appended to it, because the recogniser revises its own earlier words
   * as it hears more — it hands back the whole utterance every time, not
   * a delta. Keeping the typed part separate is what lets the spoken
   * part be rewritten underneath it without eating what came before.
   *
   * The answer is left in the box rather than sent. Reviewing it is the
   * point: dictation is a faster way to draft, not a second Live Voice.
   */
  function toggleDictation() {
    if (Dictation.active()) {
      endDictation();
      return;
    }

    const input = document.getElementById("practice-input");
    const typed = input.value.trim();
    const prefix = typed ? `${typed} ` : "";

    setMic(true);
    Dictation.start({
      text(transcript) {
        input.value = prefix + transcript;
        // Assigning .value fires no `input` event, so the box has to be
        // resized by hand or a dictated paragraph stays one line tall.
        fitInput();
      },
      end() {
        setMic(false);
        input.focus();
      },
      error: note,
    });
  }

  function endDictation() {
    Dictation.stop();
    setMic(false);
  }

  function setMic(on) {
    const button = document.getElementById("practice-mic");
    button.classList.toggle("recording", on);
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "Stop dictating" : "Speak your answer instead of typing";
  }

  /* ---- handoff mode ---- */

  async function copyPrompt() {
    const status = document.getElementById("handoff-status");
    const copied = await Handoff.copy(question);
    status.textContent = copied
      ? "Copied. Paste it into Claude, run the interview, then score yourself below."
      : "Couldn't reach the clipboard — your browser blocked it.";
    status.classList.toggle("ok", copied);
  }

  return { init, reset };
})();

/* ---------------------------------------------------------- */
/* 6. VIEW SWITCHING                                            */
/* ---------------------------------------------------------- */

const Views = (() => {
  const navMap = {
    "nav-cases": "view-cases",
    "nav-log": "view-log",
    "nav-about": "view-about",
  };

  function activate(navId) {
    Object.entries(navMap).forEach(([nav, view]) => {
      document.getElementById(nav).classList.toggle("active", nav === navId);
      document.getElementById(view).classList.toggle("active", nav === navId);
    });
  }

  function init() {
    Object.keys(navMap).forEach((navId) => {
      document.getElementById(navId).addEventListener("click", () => activate(navId));
    });
  }

  return { init };
})();

/* ---------------------------------------------------------- */
/* 7. LOGIN                                                     */
/* ---------------------------------------------------------- */

/**
 * The login modal and the nav badge that opens it.
 *
 * Signing in is never forced. `init()` only ever changes the label on a
 * single nav button; if the detective ignores it forever the site keeps
 * working from localStorage alone.
 */
const Login = (() => {
  function init() {
    document.getElementById("nav-identity").addEventListener("click", onIdentityClick);
    document.getElementById("login-submit").addEventListener("click", submit);
    document.getElementById("login-cancel").addEventListener("click", close);
    document.getElementById("login-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    document.getElementById("login-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "login-modal-backdrop") close();
    });

    renderBadge();
  }

  /** Signed out opens the modal; signed in offers to sign out. */
  function onIdentityClick() {
    if (!Identity.isSignedIn()) {
      open();
      return;
    }
    if (confirm(`Sign out of ${Identity.username()}? Your progress stays on this device.`)) {
      Identity.clear();
      renderBadge();
    }
  }

  function open() {
    setError("");
    const input = document.getElementById("login-input");
    input.value = "";
    document.getElementById("login-modal-backdrop").classList.add("open");
    input.focus();
  }

  function close() {
    document.getElementById("login-modal-backdrop").classList.remove("open");
  }

  async function submit() {
    const button = document.getElementById("login-submit");
    const name = document.getElementById("login-input").value.trim();

    if (!name) {
      setError("Every detective needs a name.");
      return;
    }

    button.disabled = true;
    button.textContent = "CHECKING…";

    try {
      await Api.signIn(name);
      close();
      renderBadge();
      // The sign-in response already carried the server log; a refresh
      // merges it with anything practised on this device beforehand.
      if (await Storage.refresh()) {
        Render.all();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      button.disabled = false;
      button.textContent = "CONTINUE";
    }
  }

  function setError(message) {
    document.getElementById("login-error").textContent = message;
  }

  function renderBadge() {
    const badge = document.getElementById("nav-identity");
    const name = Identity.username();
    badge.textContent = name || "Log In";
    badge.classList.toggle("signed-in", Boolean(name));
    badge.title = name ? "Synced to Cloudflare — click to sign out" : "Sync your progress across devices";
  }

  return { init, renderBadge };
})();

/* ---------------------------------------------------------- */
/* 8. BOOTSTRAP                                                 */
/* ---------------------------------------------------------- */

function bootstrap() {
  Render.all();
  Views.init();
  Login.init();
  Practice.init();

  // Returning detectives sync silently — no modal, no spinner, no wait.
  Storage.refresh().then((changed) => {
    if (changed) Render.all();
    // A refresh can drop an expired session, so the badge is re-read.
    Login.renderBadge();
  });

  document.getElementById("case-grid").addEventListener("click", (e) => {
    const card = e.target.closest(".case-card");
    if (card) ScoreModal.open(Number(card.dataset.caseId));
  });

  document.getElementById("modal-close").addEventListener("click", ScoreModal.close);
  document.getElementById("case-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "case-modal-backdrop") ScoreModal.close();
  });
  document.getElementById("submit-score").addEventListener("click", ScoreModal.submit);
  document.getElementById("bonus-check").addEventListener("change", ScoreModal.updateTotal);

  // A live microphone behind a dismissed modal is the one failure worth
  // wiring a keyboard escape for; ScoreModal.close() shuts Practice down.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ScoreModal.close();
  });

  document.getElementById("reset-btn").addEventListener("click", () => {
    if (confirm("Reset all XP and case history? This can't be undone.")) {
      Storage.clearLog();
      Render.all();
    }
  });
}

// Guard against sandboxed/iframe environments where the document may
// already be parsed by the time this script runs (DOMContentLoaded
// would never fire in that case).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
