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
 *   6. Views            - nav between the top-level screens
 *   7. Login            - the codename modal and the nav badge
 *   8. Minting          - that same modal's other state: invite codes
 *   9. Bootstrap        - glues user actions to state + render
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
  /**
   * One cache slot per identity.
   *
   * There used to be a single shared key. Signing in pulled an account's
   * whole history into it, and signing out cleared the identity but not
   * the cache — so the XP Log went on showing the previous detective's
   * entries, now under nobody's name at all. Clearing the cache on sign
   * out would have fixed the symptom and thrown away the device's own
   * history to do it.
   *
   * Keying by username means sign out has nothing to clear. It changes
   * which slot is being read, and the device's log is still sitting
   * where it always was. Switching accounts on a shared iPad falls out
   * of the same change for free.
   *
   * The unsuffixed key is the signed-out device log, and is also the
   * pre-sync format — anyone who practised before accounts existed finds
   * their history exactly where they left it.
   */
  const DEVICE_KEY = "caseFiles.log.v1";

  function currentKey() {
    const name = Identity.username();
    return name ? `${DEVICE_KEY}:${name}` : DEVICE_KEY;
  }

  function getLog() {
    return readKey(currentKey());
  }

  function readKey(key) {
    try {
      const raw = localStorage.getItem(key);
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
    localStorage.removeItem(currentKey());
    Api.clearLog();
  }

  /**
   * Reconcile with the server: push whatever is local, keep whatever
   * comes back. Resolves to true when the cache actually changed, so
   * the caller knows whether a re-render is worth doing.
   */
  async function refresh() {
    const pending = pendingUpload();
    const remote = await (pending.length > 0 ? Api.pushLog(pending) : Api.pullLog());
    return adopt(remote);
  }

  /**
   * Everything this device can contribute to the signed-in account: its
   * own slot, plus anything practised before signing in.
   *
   * The second half is what stops work done anonymously from being
   * stranded the moment an account slot exists to read instead. The
   * server dedupes on uid, so re-offering a device log it has already
   * absorbed costs one redundant push and changes nothing.
   */
  function pendingUpload() {
    const mine = getLog();
    if (currentKey() === DEVICE_KEY) {
      return mine;
    }
    return dedupe([...mine, ...readKey(DEVICE_KEY)]);
  }

  function dedupe(entries) {
    const seen = new Set();
    return entries.filter((entry) => {
      if (seen.has(entry.uid)) {
        return false;
      }
      seen.add(entry.uid);
      return true;
    });
  }

  /** Replace the cache with a server log. False when there's nothing to take. */
  function adopt(remote) {
    if (!remote) {
      return false;
    }
    const before = localStorage.getItem(currentKey());
    const after = JSON.stringify(remote);
    if (before === after) {
      return false;
    }
    write(remote);
    return true;
  }

  function write(log) {
    try {
      localStorage.setItem(currentKey(), JSON.stringify(log));
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
/* 1b. SAVED SESSIONS                                          */
/* ---------------------------------------------------------- */

/**
 * Half-finished practice sessions, and where they live.
 *
 * The mirror of Storage, and deliberately not part of it. Storage keeps
 * a log that must read instantly and work offline, so it caches every
 * entry in localStorage and treats the server as a background concern.
 * A draft is the opposite kind of thing: it is written once, on a
 * button press, read once, when a case is reopened, and its whole
 * purpose is to be there on a different device. Caching transcripts
 * locally would buy nothing and would have to be reconciled.
 *
 * What is cached is the *index* — which cases have a draft — because
 * the case grid asks that question once per card on every render and
 * cannot wait for a round trip to draw a badge.
 *
 * Signed out, every function here is a no-op that reports "no drafts".
 * There is no account to store one against, and the site is expected to
 * work anyway.
 *
 * Nothing in this module reads or writes XP. See the Worker's Drafts
 * layer for why that separation is load-bearing rather than tidy.
 */
const Drafts = (() => {
  // caseId -> { mode, updatedAt }. Empty until the first refresh lands,
  // which means the badges appear a beat after the grid does — the same
  // bargain Storage.refresh makes, for the same reason.
  let index = new Map();

  /**
   * Re-read the index. True when it changed, so the caller knows
   * whether redrawing the grid is worth it.
   */
  async function refresh() {
    const drafts = await Api.pullDrafts();
    const next = new Map((drafts || []).map((d) => [d.caseId, d]));
    if (same(index, next)) {
      return false;
    }
    index = next;
    return true;
  }

  /** Forget everything without asking the server — used on sign-out. */
  function clear() {
    const had = index.size > 0;
    index = new Map();
    return had;
  }

  function has(caseId) {
    return index.has(caseId);
  }

  /** The full draft for one case, or null. Always a fresh read. */
  async function load(caseId) {
    if (!has(caseId)) {
      return null;
    }
    return Api.pullDraft(caseId);
  }

  /**
   * Save a session, and only then update the index.
   *
   * Throws when the save didn't land — including when there is no
   * account to save it to, which is a refusal the caller has to show
   * rather than a failure to log. The index is written from the
   * server's answer, so a badge can only ever appear for a draft that
   * genuinely exists.
   */
  async function save(caseId, snapshot) {
    if (!Identity.isSignedIn()) {
      throw new Error("Sign in with a codename first — saved sessions live on your account.");
    }
    if (!snapshot) {
      throw new Error("There's no conversation on this case to save yet.");
    }

    const draft = await Api.pushDraft(caseId, snapshot.mode, snapshot.messages);
    index.set(caseId, { caseId, mode: draft.mode, updatedAt: draft.updatedAt });
    return draft;
  }

  /**
   * Drop a saved session. Best effort on the wire, immediate on screen:
   * the badge goes now because the detective just asked for it to, and
   * a delete that fails is a row that gets overwritten the next time
   * this case is saved.
   */
  function drop(caseId) {
    index.delete(caseId);
    Api.dropDraft(caseId);
  }

  function same(before, after) {
    if (before.size !== after.size) {
      return false;
    }
    for (const [caseId, draft] of after) {
      const was = before.get(caseId);
      if (!was || was.updatedAt !== draft.updatedAt || was.mode !== draft.mode) {
        return false;
      }
    }
    return true;
  }

  return { refresh, clear, has, load, save, drop };
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
  let swipeWired = false;

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
    // Dot clicks. The dots are rebuilt from scratch by roundCarousel()
    // on every render, so rebinding here just matches new nodes to new
    // listeners — nothing accumulates.
    document.querySelectorAll(".round-dot").forEach((dot) => {
      dot.addEventListener("click", () => goToRound(Number(dot.dataset.roundId)));
    });

    // Drag / swipe. Unlike the dots, #round-track is never recreated —
    // roundCarousel() only replaces its innerHTML — so binding these
    // listeners on every call stacked a fresh set on top of the last.
    // One physical swipe then fired onEnd once per accumulated
    // listener, each independently advancing a round: three renders
    // since load meant one swipe jumped three rounds. Wiring this once
    // is what keeps one swipe equal to one round change.
    if (swipeWired) return;
    swipeWired = true;

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

      // A draft is a place to come back to, not a result, so it is
      // marked at the top of the card beside the case number rather
      // than down in the score row. Absent entirely when there is none:
      // an empty slot on every other card would be a column of nothing.
      const draftBadge = Drafts.has(c.id)
        ? `<span class="case-draft">saved session</span>`
        : "";

      return `
        <button class="case-card" data-case-id="${c.id}">
          <span class="case-head">
            <span class="case-num">#${String(c.id).padStart(2, "0")}</span>
            ${draftBadge}
          </span>
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

/**
 * Freezes the page behind an open modal.
 *
 * iOS rubber-bands the document itself, not whatever scroll container
 * is on top of it — a drag inside `.modal-scroll` still reaches the
 * page underneath, and overscrolling past the top or bottom of that
 * page exposes blank space beyond its content. `overflow: hidden` on
 * body does not stop this on iOS; the body has to leave normal flow.
 *
 * `position: fixed` does that, but it also resets scroll to 0, so the
 * page would jump under the detective the instant a modal opens.
 * Pinning body at `top: -scrollY` cancels the jump; `unlock()` reverses
 * it and restores the exact scroll position.
 *
 * Three call sites (case, login, reset) each lock and unlock
 * independently. `depth` collapses that to one real lock so a second
 * modal opening over a first doesn't restore scroll early when only
 * the inner one closes.
 */
const BodyScroll = (() => {
  let depth = 0;
  let savedY = 0;

  function lock() {
    if (depth++ > 0) return;
    savedY = window.scrollY;
    document.body.style.top = `-${savedY}px`;
    document.body.classList.add("scroll-locked");
  }

  function unlock() {
    if (depth === 0 || --depth > 0) return;
    document.body.classList.remove("scroll-locked");
    document.body.style.top = "";
    window.scrollTo(0, savedY);
  }

  return { lock, unlock };
})();

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
    BodyScroll.lock();

    resume(activeCase.id);
  }

  /**
   * Put a saved session back, if there is one.
   *
   * The modal is already open and already usable by the time this runs.
   * That ordering is deliberate: the draft costs a round trip, and a
   * case file that waits on the network before it will show you the
   * question is worse than one that fills a conversation in a moment
   * later. Drafts.has() means the trip is only ever made for a case
   * that actually has something to fetch.
   *
   * The guard on the way back is the point of the whole function being
   * async. A slow answer can arrive after the case was closed, or after
   * a different one was opened, and restoring it then would drop a
   * stranger's conversation into whatever is on screen.
   */
  async function resume(caseId) {
    if (!Drafts.has(caseId)) return;

    const draft = await Drafts.load(caseId);
    if (!draft || !activeCase || activeCase.id !== caseId) return;

    Practice.restore(draft, () => {
      Drafts.drop(caseId);
      Render.caseGrid();
    });
  }

  /**
   * The X button, backdrop click, and Escape all land here. Closing
   * this way is a discard, not a save, so it asks first whenever
   * there's something on the case that hasn't been scored — a dot set
   * by hand, a typed exchange, or a Live Voice conversation. `submit`
   * below is the one exit that bypasses this: it has already saved the
   * case and calls `forceClose` directly.
   *
   * The dialog offers to keep the conversation, and `session` is what
   * decides whether that offer appears. A case with dots set and
   * nothing said has no session to resume, so it gets the two-button
   * dialog it always had rather than a Save button that would write an
   * empty draft.
   *
   * Note what is not saved by any of this: the dots. They are a score,
   * scores are Close the Case's business, and a draft that could carry
   * one would be a second path to XP.
   */
  function close() {
    // Escape is bound at the document, so this runs on the case grid
    // too, with no case open. `scores` still holds whatever the last
    // case was given — it is refilled by `open`, not cleared by
    // `forceClose` — so without this the grid answers Escape with a
    // dialog about work that was logged ten minutes ago.
    if (!activeCase) {
      return;
    }

    if (!hasUnsavedWork()) {
      forceClose();
      return;
    }

    const caseId = activeCase.id;
    ExitConfirm.open({
      session: Practice.snapshot(),
      save: (snapshot) => Drafts.save(caseId, snapshot),
      exit: forceClose,
    });
  }

  function hasUnsavedWork() {
    const scored = Object.values(scores).some((value) => value > 0);
    return scored || Practice.hasProgress();
  }

  function forceClose() {
    document.getElementById("case-modal-backdrop").classList.remove("open");
    BodyScroll.unlock();
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
    // The case has been closed, so the resume point is spent. Leaving it
    // would put a "saved session" badge on a case that was just logged,
    // and reopening it would restore the conversation that produced the
    // score already in the log. Unconditional because dropping a draft
    // that was never there is a no-op.
    Drafts.drop(activeCase.id);
    forceClose();
    Render.all();
  }

  return { open, close, submit, applyGrades, updateTotal };
})();

/* ---------------------------------------------------------- */
/* 4b. LEAVING A CASE                                           */
/* ---------------------------------------------------------- */

/**
 * The one decision between a close attempt and losing a case's
 * progress. Three answers, and they are genuinely three:
 *
 *   Save session   keep the conversation, come back to it later
 *   Discard        leave, keep nothing
 *   Cancel         stay in the case
 *
 * Shares the reset-confirm modal's markup and glass so it reads as the
 * same kind of decision, not a browser dialog to reflex past. It holds
 * no opinion about what "unsaved" means or where a session goes —
 * ScoreModal decides the first and hands over callbacks for the rest.
 *
 * Save is the one button here that can fail, and the one that must not
 * fail quietly: the modal is closing on work that was promised to be
 * kept. So it waits for the write, says so while it waits, and on
 * failure stays open with the reason on screen rather than closing and
 * hoping. Discard and Cancel are instant because neither of them owes
 * anything to a network.
 */
const ExitConfirm = (() => {
  let plan = null;

  function init() {
    document.getElementById("exit-cancel").addEventListener("click", close);
    document.getElementById("exit-save").addEventListener("click", saveThenExit);
    document.getElementById("exit-discard").addEventListener("click", () => {
      const exit = plan && plan.exit;
      close();
      if (exit) exit();
    });
    document.getElementById("exit-modal-backdrop").addEventListener("click", (e) => {
      // Backdrop is Cancel, not Discard. The safest of the three answers
      // is the one a stray tap should land on.
      if (e.target.id === "exit-modal-backdrop") close();
    });
  }

  /**
   * @param session  what Practice.snapshot() found, or null. Null hides
   *                 the Save button — there is nothing to save, and a
   *                 button that writes an empty draft is worse than no
   *                 button at all.
   * @param save     async, takes the session, throws with a sentence
   *                 worth showing.
   * @param exit     tears the case modal down. Runs after a successful
   *                 save and after a discard, never after a cancel.
   */
  function open({ session, save, exit }) {
    plan = { session, save, exit };
    setError("");
    setSaving(false);
    document.getElementById("exit-save").hidden = !session;
    document.getElementById("exit-sub").textContent = subtitleFor(session);
    document.getElementById("exit-modal-backdrop").classList.add("open");
  }

  function close() {
    document.getElementById("exit-modal-backdrop").classList.remove("open");
    plan = null;
  }

  function isOpen() {
    return document.getElementById("exit-modal-backdrop").classList.contains("open");
  }

  async function saveThenExit() {
    if (!plan || !plan.session) return;
    const { session, save, exit } = plan;

    setError("");
    setSaving(true);
    try {
      await save(session);
      close();
      exit();
    } catch (err) {
      // Deliberately still open, with the case behind it intact. The
      // work is only lost if this dialog closes, so the one outcome
      // worth ruling out is closing on a failed save.
      setError(err.message);
      setSaving(false);
    }
  }

  /**
   * What the detective is actually being asked about. A case with a
   * conversation on it and one with only dots set are two different
   * losses, and saying "scores and conversation" for both taught
   * neither.
   */
  function subtitleFor(session) {
    if (!session) {
      return "The scores you've set haven't been logged. Closing now discards them.";
    }
    const mode = session.mode === "voice" ? "Live Voice" : "Text Practice";
    return `Save this ${mode} session to pick it up later on any device, ` +
      "or discard it. Either way the dots aren't logged until you close the case.";
  }

  function setSaving(saving) {
    const button = document.getElementById("exit-save");
    button.disabled = saving;
    button.textContent = saving ? "SAVING…" : "SAVE SESSION";
    document.getElementById("exit-discard").disabled = saving;
    document.getElementById("exit-cancel").disabled = saving;
  }

  function setError(message) {
    document.getElementById("exit-error").textContent = message;
  }

  return { init, open, close, isOpen };
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
  // Set only while a saved session is on screen: what to run if the
  // detective decides they'd rather start the case cold. See restore.
  let discardDraft = null;

  function init() {
    document.getElementById("practice-modes").addEventListener("click", (e) => {
      const button = e.target.closest(".practice-mode");
      if (button) choose(button.dataset.mode);
    });

    document.getElementById("practice-send").addEventListener("click", send);

    const input = document.getElementById("practice-input");
    input.addEventListener("input", onInput);
    document.getElementById("preview-body").addEventListener("click", editFromPreview);
    input.addEventListener("keydown", (e) => {
      // Enter sends, as it did when this was a single-line field.
      // Shift+Enter is the escape hatch now that a line break is
      // something the box can actually hold.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    document.getElementById("preview-expand").addEventListener("click", toggleExpand);
    document.getElementById("practice-mic").addEventListener("click", toggleDictation);

    document.getElementById("mic-caret").addEventListener("click", toggleMicMenu);
    document.getElementById("mic-menu").addEventListener("click", chooseMic);
    // Plugging in AirPods mid-session should show up without a reload.
    Microphones.onChange(() => listMics());
    document.getElementById("voice-toggle").addEventListener("click", toggleVoice);
    document.getElementById("voice-stop").addEventListener("click", () => Voice.interrupt());
    document.getElementById("handoff-copy").addEventListener("click", copyPrompt);
    document.getElementById("practice-resume-fresh").addEventListener("click", startFresh);
  }

  /** Start a fresh session for `question`, or tear everything down with null. */
  function reset(nextQuestion) {
    endVoice();
    endDictation();
    question = nextQuestion;
    mode = null;
    transcript = [];
    waiting = false;
    discardDraft = null;

    document.getElementById("practice-resume").hidden = true;
    document.getElementById("practice-panel").hidden = true;
    document.getElementById("practice-panel").classList.remove("notice-only");
    document.getElementById("chat-log").innerHTML = "";
    document.getElementById("practice-input").value = "";
    settleTyping();
    refreshComposer();
    document.getElementById("handoff-status").textContent = "";
    document.querySelectorAll(".practice-mode").forEach((b) => b.classList.remove("active"));
    markModes();
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

    // The composer's visibility is decided once, further down, where the
    // access check has already run — two places setting it would mean
    // whichever ran last silently won.
    document.getElementById("practice-panel").hidden = false;
    document.getElementById("practice-input").placeholder =
      mode === "voice" ? "Or type a quick question…" : "Type your answer and hit enter";

    // Dictation is a Text Practice convenience. Live Voice already has a
    // microphone, and a second one next to it would be two buttons doing
    // visibly different things with the same icon.
    document.getElementById("practice-mic").hidden =
      mode !== "text" || !Dictation.supported();

    // The picker stays up in Live Voice too — the device matters just as
    // much there, and the orb's mic button is nowhere near it.
    closeMicMenu();
    listMics();

    const blocked = mode === "handoff" ? "" : aiBlocked();

    // Voice mode opens the conversation immediately but not the
    // microphone — a typed aside is a valid first turn, and it shouldn't
    // have to trigger a permission prompt to be heard.
    if (mode === "voice" && !blocked && Voice.supported()) {
      Voice.attach(question, voiceHandlers());
    }

    // Without a way in, the composer is furniture that does nothing.
    // Hiding it says "not here" more clearly than a box that accepts
    // typing and then refuses to send it.
    document.getElementById("practice-composer").hidden = mode === "handoff" || Boolean(blocked);

    // Blocked, the panel holds one notice and an empty stage, so it
    // shrinks to the notice and leaves it stranded against the top edge.
    // The panel can't work this out for itself — an empty chat log and a
    // chat log about to be filled look identical to CSS — so the layer
    // that knows why the stage is empty says so.
    document.getElementById("practice-panel").classList.toggle("notice-only", Boolean(blocked));

    showOpeningNote();

    // Asking the log whether it's empty rather than the transcript:
    // leaving text mode and coming back re-runs this, and the transcript
    // being empty doesn't mean the hint isn't already on screen. Only
    // `reset` clears the log, so this seeds exactly once per case.
    //
    // "hint", not "assistant" — it's an instruction to the room, not a
    // turn in the conversation, so it centres instead of sitting in a
    // bubble on Claude's side.
    if (mode === "text" && !blocked && !document.getElementById("chat-log").hasChildNodes()) {
      say("hint", "Whenever you're ready — answer the question above and I'll score it.");
    }
  }

  /**
   * Mark the two paid modes as locked when they are.
   *
   * A label, not an enforcement — the buttons stay clickable so the
   * click can explain itself. A disabled button that says nothing when
   * pressed is the worst version of this: it looks broken rather than
   * gated, and nobody learns that an invite code is the thing to ask for.
   */
  function markModes() {
    const locked = Boolean(aiBlocked());
    document.querySelectorAll(".practice-mode").forEach((button) => {
      const paid = button.dataset.mode !== "handoff";
      button.classList.toggle("locked", paid && locked);
    });
  }

  /**
   * The one question the two AI modes have to answer before they do
   * anything: may this person spend Anthropic credit?
   *
   * Returns "" when they may, or the sentence explaining why not. Every
   * path that could reach /api/coach — the send button, Enter, the mic,
   * the orb — consults this first, so a blocked detective never makes
   * the request at all rather than making it and being refused. The
   * Worker refuses it too; this is the half that keeps the refusal from
   * costing a round trip and looking like a bug.
   *
   * Send to Claude is never blocked and is named in every message,
   * because it does the same job for free and the message is the only
   * place someone would learn that.
   */
  function aiBlocked() {
    if (!Identity.isSignedIn()) {
      return "Sign in with a codename first — AI practice runs through your Cloudflare Worker.";
    }

    const access = Identity.access();

    if (access.tier === "free") {
      return (
        "AI coaching needs an invite code — add one from the Log In panel. " +
        "Send to Claude is open to everyone: copy the prompt, practise in the Claude app, " +
        "and score it here by hand."
      );
    }

    if (!access.ai) {
      return (
        `Usage limit reached — this invite code has spent its $${money(access.cap)} of AI coaching. ` +
        "Send to Claude and manual scoring are unaffected. Ask Kheera to raise the cap to carry on."
      );
    }

    return "";
  }

  /**
   * Put the right note on screen for the mode that was just opened.
   *
   * Access first, because a browser with no speech engine is a smaller
   * problem than not being allowed to use the mode at all. If none of
   * the problems apply, the line is the remaining budget — which is not
   * a problem, and says so by not being dressed as one.
   */
  function showOpeningNote() {
    if (mode === "handoff") {
      note("");
      return;
    }

    const blocked = aiBlocked();
    if (blocked) {
      note(blocked, "warn");
      return;
    }

    if (mode === "voice" && !Voice.supported()) {
      note("This browser has no speech engine. Chrome or Edge will do it; Text Practice works anywhere.", "warn");
      return;
    }

    note(budgetNote(), "info");
  }

  /**
   * How much of the invite code's budget is left.
   *
   * Shown rather than hidden because the alternative is a session that
   * stops mid-answer with no warning. The owner sees nothing here —
   * there is no cap, so there is no number worth a line of the screen.
   */
  function budgetNote() {
    const access = Identity.access();
    if (access.tier !== "invited") {
      return "";
    }
    return `AI coaching: $${money(access.remaining)} of $${money(access.cap)} left on your invite code.`;
  }

  function money(usd) {
    return Number(usd || 0).toFixed(2);
  }

  /**
   * The one line above the practice panel.
   *
   * `tone` decides whether it looks like a problem. The note started out
   * carrying only refusals, so it was styled in the danger colour
   * outright — which meant a healthy budget was announced in alarm pink,
   * reading as a failure at a glance. Warnings keep the pink; a running
   * total is just information and is dressed as such.
   */
  function note(message, tone = "warn") {
    const element = document.getElementById("practice-note");
    element.textContent = message;
    element.hidden = !message;
    element.classList.toggle("note-info", tone === "info");
  }

  /* ---- composer: one message, one surface ---- */

  /**
   * The composer shows the message being written in exactly one place at
   * a time — never the card and the box together.
   *
   *   capturing   words are arriving, by keyboard or microphone. The
   *               card carries them, larger, and the box tucks away.
   *   idle        nothing has arrived for a moment. The box comes back
   *               with the caret where it was; the card stands down.
   *   expanded    the detective asked to read it all. Card, full size,
   *               whichever of the two above is true.
   *
   * `capturing` is a fading fact, not an event — it stays true through
   * the pauses inside a sentence and lapses only after a real stop.
   * TYPING_PAUSE_MS is long for the same reason the voice threshold is:
   * someone composing an interview answer stops to think mid-clause, and
   * swapping the surface under them every time they do would be worse
   * than the duplication this replaces. Dictation doesn't need a timer —
   * the microphone already says when it's finished.
   */
  const TYPING_PAUSE_MS = 2500;
  let typingRecent = false;
  let typingTimer = null;

  function onInput() {
    typingRecent = true;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingRecent = false;
      refreshComposer();
    }, TYPING_PAUSE_MS);
    refreshComposer();
  }

  /** Drop straight to idle — sending, clearing, or asking to edit. */
  function settleTyping() {
    clearTimeout(typingTimer);
    typingRecent = false;
  }

  /**
   * Make the composer reflect what's in it — content, which surface is
   * showing, and the height of the box.
   *
   * One function rather than three because there is no moment when only
   * part of it should happen, and every caller would otherwise have to
   * remember the set. Called from the `input` event and from everywhere
   * the value is set in code — dictation rewriting the transcript,
   * send() clearing it, reset() emptying it. Programmatic assignment
   * fires no `input` event, so a box filled by the microphone would
   * otherwise sit three lines tall under a blank card.
   */
  function refreshComposer() {
    const input = document.getElementById("practice-input");
    const card = document.getElementById("composer-preview");
    const expand = document.getElementById("preview-expand");

    const text = input.value;
    const hasText = Boolean(text.trim());
    const capturing = hasText && (Dictation.active() || typingRecent);
    const expanded = hasText && card.classList.contains("expanded");
    const onCard = capturing || expanded;

    document.getElementById("preview-body").textContent = text;
    document.getElementById("preview-count").textContent = countOf(text);
    document.getElementById("preview-label").textContent = labelFor(capturing, expanded);
    card.classList.toggle("capturing", capturing && !expanded);
    card.hidden = !onCard;

    // Nothing to expand and nothing to collapse back into.
    expand.hidden = !hasText;
    if (!hasText) setExpanded(false);

    input.classList.toggle("tucked", onCard);
    if (onCard) {
      input.style.height = "0px";
      return;
    }

    // Collapsing to `auto` first is what allows it to shrink again; read
    // against a fixed height, scrollHeight can only ever grow. The floor
    // and ceiling are CSS's business, not this function's.
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  function labelFor(capturing, expanded) {
    if (expanded) return "Your answer";
    if (Dictation.active()) return "Listening";
    if (capturing) return "Writing";
    return "Your answer";
  }

  function countOf(text) {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return words === 1 ? "1 word" : `${words} words`;
  }

  /**
   * Grow the preview into a full reading view and back. Available in
   * either state, which is why its button sits in the composer row
   * rather than inside the card it opens.
   *
   * The collapsed card fades its bottom edge instead of cutting a line
   * in half, which is what signals there's more without a scrollbar
   * having to say so. Expanded, the text genuinely ends, so the fade
   * comes off and the card scrolls instead.
   */
  function toggleExpand() {
    const open = !document.getElementById("composer-preview").classList.contains("expanded");
    setExpanded(open);
    // Closing the card while words are still arriving would hand back a
    // box that's about to be tucked away again; settling first means
    // collapse always lands on the editor.
    if (!open) settleTyping();
    refreshComposer();
    if (!open) document.getElementById("practice-input").focus();
  }

  /**
   * The way back to a caret. While the card is up the box is collapsed
   * and can't be clicked, so the text itself is the target — tapping it
   * stops the capture and returns the editor.
   */
  function editFromPreview() {
    endDictation();
    settleTyping();
    setExpanded(false);
    refreshComposer();
    document.getElementById("practice-input").focus();
  }

  function setExpanded(open) {
    const card = document.getElementById("composer-preview");
    const button = document.getElementById("preview-expand");
    card.classList.toggle("expanded", open);
    // The icon swap is driven from the composer, since that's where the
    // button lives and the card may be hidden when it's pressed.
    document.getElementById("practice-composer").classList.toggle("composer-open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Collapse your answer" : "Expand your answer");
    button.title = open ? "Collapse" : "Expand to read it all";
  }

  /* ---- text mode ---- */

  function send() {
    const input = document.getElementById("practice-input");
    const said = input.value.trim();
    if (!said || waiting) return;

    // The last gate before a message becomes an API call. Everything
    // above this line is free; everything below it is billable.
    const blocked = aiBlocked();
    if (blocked) {
      note(blocked);
      return;
    }

    // Dictating and then sending shouldn't leave the microphone running
    // over the top of the reply, and the composer has to land on idle so
    // the empty box comes back rather than a tucked one.
    endDictation();
    settleTyping();

    // In voice mode the composer is a side channel into the same
    // conversation, so Voice takes it and answers out loud. It only
    // declines when there's no conversation to add to — an unsupported
    // browser — and that has to be said rather than swallowed.
    if (mode === "voice") {
      // Waiting out the reply is the rule for the microphone, so it is
      // the rule for the text box too — otherwise the one thing you
      // can't do by talking is the one thing you can do by typing.
      if (Voice.busy()) {
        note("Let the interviewer finish, or press Stop to take the floor.");
        return;
      }
      if (Voice.submit(said)) {
        input.value = "";
        refreshComposer();
      } else {
        // Voice declined a typed aside, which only happens when there
        // is no conversation to add it to. If access explains why, say
        // that; otherwise it is the missing speech engine.
        if (aiBlocked() || !Voice.supported()) {
          showOpeningNote();
        } else {
          note("Live Voice needs a browser with a speech engine — try Chrome or Edge.", "warn");
        }
      }
      return;
    }

    input.value = "";
    refreshComposer();
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
        settleBudget();
      },
      error(message) {
        waiting = false;
        bubble.textContent = message;
        bubble.parentElement.classList.add("chat-error");
        scrollChat();
        // A refusal is worth re-reading the budget over: the most likely
        // reason for one is the cap this would have crossed.
        settleBudget();
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
        // The caption belongs to whoever is talking, and a state change
        // is exactly the moment it changes hands. Clearing it here is
        // what stops the candidate's transcript sitting under Claude's
        // reply: `heard` and `said` each write a whole caption, so the
        // only way they stack is if the last turn's text is still there
        // when the next one starts writing.
        setOrb(state, LABELS[state], "");
      },
      heard(text) {
        setOrb(null, null, text);
      },
      said(text) {
        setOrb(null, null, text);
      },
      beat(word) {
        pulseOrb(word);
      },
      grades(scores) {
        ScoreModal.applyGrades(scores);
        settleBudget();
      },
      error: note,
    };
  }

  /**
   * Re-read the budget after a turn has been paid for.
   *
   * The turn that exhausts a code is the one that has to say so — a
   * cap discovered on the next click is a session that ends in a
   * rejection instead of a warning. Cheap enough to do per turn: one
   * indexed row, and only for accounts that have a cap at all.
   */
  function settleBudget() {
    if (Identity.access().tier !== "invited") {
      return;
    }
    Api.refreshAccess().then(() => {
      markModes();
      if (mode === "text" || mode === "voice") {
        showOpeningNote();
      }
    });
  }

  /**
   * Opens and closes the microphone, not the conversation. `choose`
   * already attached one, so a typed aside works before this is ever
   * clicked and the history survives closing the mic again.
   */
  function toggleVoice() {
    // First thing, before any branch — this is a click handler, and on
    // WebKit that makes it the only place on the whole Live Voice path
    // with the standing to authorise speech. Everything Claude says
    // arrives later, from a network stream, with no gesture anywhere
    // behind it; if the permission isn't taken here it is never
    // available at all. Cheap, silent, and idempotent, so it costs
    // nothing to do it on the closing tap too.
    Speaker.unlock();

    if (live) {
      endVoice();
      return;
    }

    // Opening the microphone is where Live Voice starts costing money,
    // so the access check belongs here and not only at mode selection —
    // a cap can be reached mid-session, between one turn and the next.
    if (aiBlocked() || !Voice.supported()) {
      showOpeningNote();
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

  /**
   * The orb's glow while Claude is speaking.
   *
   * Words are the input, not the output. Firing one animation per word
   * put the timing on screen literally and it read as a strobe — speech
   * runs at two or three words a second, which is well inside the range
   * the eye reports as flicker rather than rhythm. The signal was right
   * and the rendering of it was wrong.
   *
   * So words feed a level instead of drawing a frame. Each one adds a
   * small amount of energy, that energy bleeds away continuously, and
   * what is drawn chases the result rather than tracking it — the two
   * time constants are long enough that per-word ripple is averaged out
   * before it reaches the screen. What survives is the shape at the
   * scale speech actually has one: the glow builds through a phrase,
   * eases at a comma, sags in the breath between sentences, and falls
   * away when the voice stops.
   *
   * Falling is slower than rising, because that is how light and breath
   * both behave, and a symmetric envelope reads as mechanical.
   */
  const OrbGlow = (() => {
    // How long the accumulated energy takes to bleed away, and how
    // quickly the drawn level chases it. RISE/FALL are deliberately far
    // longer than the ~380ms between words: that gap is what turns a
    // string of discrete words into one continuous swell.
    const DECAY_MS = 1100;
    const RISE_MS = 320;
    const FALL_MS = 800;

    /**
     * How far a word closes the gap to full, before its length counts.
     *
     * A word closes a fraction of what's left rather than adding a fixed
     * amount, which is what keeps the level bounded no matter how fast
     * the voice is. Adding did not: energy accumulated faster than it
     * decayed, so any clause longer than a few words pinned the glow at
     * maximum and the only visible movement left was the pauses. A
     * quick voice should read as brighter than a slow one, not as
     * permanently saturated.
     */
    const ATTACK = 0.38;

    // A clause end is a real pause in the speech, so it is a real dip in
    // the light. This is the one place a single word moves the level on
    // its own, and it moves it down.
    const CLAUSE = /[,.;:!?—]$/;
    const CLAUSE_RELEASE = 0.55;

    // Steady speech settles somewhere around 0.4–0.65 depending on how
    // fast the voice is, so the drawn value is scaled to use the range
    // the eye is actually given. Headroom above it is deliberate: it is
    // what a dense run of long words has left to climb into.
    const GAIN = 1.1;

    /**
     * Where the quiet end of the scale sits, and how far the loud end
     * reaches past it.
     *
     * Smoothing the flicker away had left the whole effect nearly
     * invisible, and the reason is worth naming: the level during speech
     * only travels between about 0.6 and 0.85, so mapping 0..1 straight
     * onto the orb spent most of the available range on values the orb
     * never actually shows. FLOOR and SPAN re-aim the output at the part
     * of the scale speech uses, which buys a much wider swing without
     * touching a single time constant — the smoothing is exactly as it
     * was, it is only being shown at a legible size.
     */
    const FLOOR = 0.34;
    const SPAN = 1.5;

    /**
     * How far from round the orb is allowed to get, and how fast the
     * bulge travels around it.
     *
     * The wobble is a rotating ellipse rather than a morphing outline: a
     * long axis that slowly walks around the orb reads as something soft
     * being pushed from the inside, which is the same thing a blob does
     * and costs a transform rather than a repaint. That matters on the
     * glass layer especially, which carries a backdrop-filter — warping
     * its border-radius would re-blur what's behind it every frame, on
     * the device least able to afford it.
     *
     * Each layer gets its own rate and its own starting angle. Moving
     * them together would read as one rigid object being squeezed; it is
     * the disagreement between them that reads as alive.
     */
    const WARP_MIN = 0.018;
    const WARP_MAX = 0.062;
    const AXIS_DPS = 23;

    let energy = 0;
    let level = 0;
    let last = 0;
    let frame = null;

    /** One word spoken. Adds energy; never draws anything itself. */
    function beat(word) {
      const text = typeof word === "string" ? word : "";
      // Longer words hold the voice longer, so they pull harder.
      const attack = ATTACK + Math.min(0.16, text.length * 0.016);
      energy += (1 - energy) * attack;
      if (CLAUSE.test(text)) {
        energy *= CLAUSE_RELEASE;
      }
      start();
    }

    /**
     * Advance the model to `now` and return what should be drawn.
     *
     * Pure apart from the two counters it carries, and time is a
     * parameter rather than something it reads — which is what makes the
     * envelope testable without a browser or a clock.
     */
    function advance(now) {
      const dt = Math.min(120, now - last);
      last = now;
      energy *= Math.exp(-dt / DECAY_MS);
      const tau = energy > level ? RISE_MS : FALL_MS;
      level += (energy - level) * (1 - Math.exp(-dt / tau));
      // Expanded about FLOOR rather than about zero, so silence still
      // lands at nothing and the speaking band gets the rest of the
      // range. Clamped at both ends: below, so a fading tail can't push
      // the orb inside-out; above, so a dense run of long words tops out
      // bright instead of overshooting into something the CSS never
      // anticipated.
      const shown = (Math.min(1, level * GAIN) - FLOOR) * SPAN + FLOOR * SPAN * 0.35;
      return Math.max(0, Math.min(1, shown));
    }

    function start() {
      if (frame !== null) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }

    function tick(now) {
      const shown = advance(now);
      paint(shown, now);
      // Runs on while there is anything left to show, so the glow fades
      // out on its own after the last word instead of being cut.
      if (level > 0.002 || energy > 0.002) {
        frame = requestAnimationFrame(tick);
        return;
      }
      frame = null;
      release();
    }

    /**
     * An ellipse of the given size, bulging by `warp` along an axis at
     * `deg`. The two rotations cancel for anything downstream — only the
     * scale between them is left tilted — so the layer stays upright
     * while its long axis walks around it.
     */
    function wobble(size, warp, deg) {
      const x = (size * (1 + warp)).toFixed(4);
      const y = (size * (1 - warp)).toFixed(4);
      return `rotate(${deg.toFixed(2)}deg) scale(${x}, ${y}) rotate(${(-deg).toFixed(2)}deg)`;
    }

    function paint(shown, now) {
      const orb = document.getElementById("orb");
      const core = orb && orb.querySelector(".orb-core");
      const halo = orb && orb.querySelector(".orb-halo");
      const glass = orb && orb.querySelector(".orb-glass");
      if (!core) return;

      const seconds = now / 1000;
      const warp = WARP_MIN + shown * (WARP_MAX - WARP_MIN);

      orb.dataset.pulse = "speech";

      core.style.transform = wobble(0.88 + shown * 0.42, warp, seconds * AXIS_DPS);
      // Ceilings kept inside the range the cyan states use — cyan's core
      // rests at 0.6 and its halo peaks at 0.85. Driving these to a flat
      // 1.0 was most of what made the green read as a harsher material
      // than the blue: same gradients, but lit past anything the rest of
      // the orb ever reaches. The travel is what carries the speech; the
      // brightness only has to say "this one is talking".
      core.style.opacity = (0.34 + shown * 0.44).toFixed(4);

      if (glass) {
        // Least of the three. This is the sphere the eye reads as the
        // object's edge, and an edge that moves as much as the light
        // inside it stops looking like glass.
        glass.style.transform = wobble(1, warp * 0.55, 90 - seconds * AXIS_DPS * 0.72);
      }

      if (halo) {
        halo.style.transform = wobble(1.24 + shown * 0.34, warp * 0.8, 40 + seconds * AXIS_DPS * 0.61);
        halo.style.opacity = (0.34 + shown * 0.46).toFixed(4);
      }
    }

    /** Hand the orb back to CSS, leaving nothing inline behind. */
    function release() {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      energy = 0;
      level = 0;
      const orb = document.getElementById("orb");
      if (!orb) return;
      delete orb.dataset.pulse;
      [".orb-core", ".orb-halo", ".orb-glass"].forEach((sel) => {
        const el = orb.querySelector(sel);
        if (!el) return;
        el.style.transform = "";
        el.style.opacity = "";
      });
    }

    return { beat, release, advance };
  })();

  /**
   * One word, handed to the glow.
   *
   * Motion is the whole of this effect, so honouring reduced-motion
   * means not running it at all rather than running it gently. The CSS
   * fallback loop is suppressed for those users by the same query, and
   * `data-pulse` is never set, so nothing here leaves the orb stranded.
   */
  function pulseOrb(word) {
    if (typeof requestAnimationFrame !== "function") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    OrbGlow.beat(word);
  }

  /** Null for state or caption means "leave that one alone". */
  function setOrb(state, label, caption) {
    if (state !== null) {
      document.getElementById("orb").dataset.state = state;
      // The glow belongs to one stretch of speech. Releasing it at every
      // state change is what stops a finished reply leaving the orb
      // frozen at whatever brightness the last word left it, and clears
      // the inline styles so the CSS states can take the orb back.
      if (state !== "speaking") {
        OrbGlow.release();
      }
      // The label sits beside the orb, not inside it, so it can't pick
      // up the state through descendant CSS — it needs its own copy to
      // recolour itself when Claude starts speaking.
      document.getElementById("orb-state").dataset.state = state;
      // Stop exists only while there is speech to stop. Driving it from
      // the state means it can't outlive the reply: whatever ends the
      // turn — finishing, being stopped, the mic closing — arrives here
      // as a state change and takes the button with it.
      document.getElementById("voice-stop").hidden = state !== "speaking";
    }
    if (label !== null && label !== undefined) {
      document.getElementById("orb-state").textContent = label;
    }
    if (caption !== null && caption !== undefined) {
      // Whitespace-only counts as nothing. The caption collapses when
      // it's empty (see .orb-caption:empty), and a lone space from a
      // speech engine still filling in would hold the gap open while
      // showing nothing — the exact thing that rule exists to prevent.
      document.getElementById("orb-caption").textContent = caption.trim() ? caption : "";
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
    // The card takes over the moment the mic opens, before a word lands,
    // so the surfaces don't swap a beat late.
    refreshComposer();
    // The permission prompt is happening regardless now, so this is the
    // cheap moment to turn "Microphone 1, 2" into real device names.
    listMics({ prime: true });

    Dictation.start({
      text(transcript) {
        input.value = prefix + transcript;
        // Assigning .value fires no `input` event, so nothing else would
        // tell the composer that the message just changed.
        refreshComposer();
      },
      end() {
        setMic(false);
        // Dictation.active() is already false here, so this is what hands
        // the box back with the transcript in it, ready to edit.
        refreshComposer();
        input.focus();
      },
      error: note,
    });
  }

  function endDictation() {
    Dictation.stop();
    setMic(false);
    refreshComposer();
  }

  /* ---- which microphone ---- */

  /**
   * Fill the device menu.
   *
   * `prime` decides whether it's willing to spend a permission prompt to
   * learn the real device names. Opening the menu isn't worth one on its
   * own — but it rarely needs one either: once the microphone has been
   * granted, enumerateDevices() keeps handing back real labels for the
   * rest of the session, and Chrome remembers the grant across visits.
   * Generic names mean the page has genuinely never held a microphone.
   * Pressing dictate primes, because the prompt is coming anyway.
   *
   * Rebuilt every time the menu opens rather than cached, so a device
   * plugged in since last time is simply there, and so labels upgrade
   * from generic to real the moment permission exists.
   *
   * What it can't do is make the recogniser obey. SpeechRecognition
   * takes no device, so this reports and requests rather than commands.
   * The note at the foot of the menu says so — that's where someone
   * choosing a device will actually read it.
   */
  async function listMics({ prime = false } = {}) {
    const picker = document.getElementById("mic-picker");
    const menu = document.getElementById("mic-menu");

    if (!Microphones.supported() || !Dictation.supported()) {
      picker.hidden = true;
      return;
    }

    picker.hidden = mode === "handoff";
    if (picker.hidden) {
      closeMicMenu();
      return;
    }

    // Named devices only. Until the microphone has been granted once the
    // browser withholds every label, and this comes back empty — leaving
    // a single "System default" row, which is the whole truth available
    // at that point.
    const devices = await Microphones.list({ prime });

    // A remembered device that has since been unplugged falls back to
    // the default rather than showing a selection that isn't real.
    const saved = Microphones.chosen();
    const live = devices.some((d) => d.id === saved) ? saved : "";
    if (live !== saved) Microphones.choose(live);

    const rows = [{ id: "", label: "System default" }, ...devices];
    menu.innerHTML =
      `<div class="mic-list">${rows.map((d) => option(d, d.id === live)).join("")}</div>` +
      `<p class="mic-note">${noteFor(devices.length)}</p>`;

    document.getElementById("mic-caret").classList.toggle("chosen", Boolean(live));
  }

  /**
   * A lone default row needs explaining, or it reads as a broken list
   * rather than a browser withholding names it hasn't been asked for.
   */
  function noteFor(count) {
    if (count === 0) {
      return `Your devices will be listed once you've allowed the
              microphone — press the mic button to do that.`;
    }
    return `Browser speech recognition follows your system default input.
            If a choice here doesn't take, change the default in your
            computer's sound settings.`;
  }

  function option(device, selected) {
    return `
      <button type="button" class="mic-option" role="option"
              aria-selected="${selected}" data-device="${escapeAttr(device.id)}">
        <span class="tick" aria-hidden="true">✓</span>
        <span class="name">${escapeText(device.label)}</span>
      </button>
    `;
  }

  /* ---- the menu ---- */

  function toggleMicMenu() {
    if (document.getElementById("mic-menu").hidden) {
      openMicMenu();
    } else {
      closeMicMenu();
    }
  }

  function openMicMenu() {
    document.getElementById("mic-menu").hidden = false;
    document.getElementById("mic-picker").classList.add("open");
    document.getElementById("mic-caret").setAttribute("aria-expanded", "true");
    // Capture phase, so a click anywhere closes it before that click can
    // be acted on twice.
    document.addEventListener("click", onClickAway, true);
    listMics();
  }

  /** True when there was a menu to close — the Escape key asks first. */
  function closeMicMenu() {
    const menu = document.getElementById("mic-menu");
    const wasOpen = !menu.hidden;
    menu.hidden = true;
    document.getElementById("mic-picker").classList.remove("open");
    document.getElementById("mic-caret").setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onClickAway, true);
    return wasOpen;
  }

  function onClickAway(event) {
    if (!event.target.closest("#mic-picker")) closeMicMenu();
  }

  function chooseMic(event) {
    const option = event.target.closest(".mic-option");
    if (!option) return;
    Microphones.choose(option.dataset.device);
    closeMicMenu();
    listMics();
  }

  function escapeAttr(value) {
    return String(value).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  function escapeText(value) {
    return String(value).replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
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

  /**
   * Shut anything transient that's open. Reports whether there was
   * something, so Escape can dismiss a menu without also closing the
   * case behind it.
   */
  function dismiss() {
    return closeMicMenu();
  }

  /**
   * Whether this case has anything on it that closing would throw away.
   *
   * Scored dots are ScoreModal's own business and checked there. This
   * covers the two modes that hold state of their own: a typed exchange
   * Coach hasn't graded yet, and a Live Voice conversation in the same
   * position — checked regardless of which mode is on screen right now,
   * since switching modes mid-session doesn't clear the one left behind.
   * Handoff has nothing to lose: the prompt lives on the clipboard, not
   * in here.
   */
  function hasProgress() {
    return transcript.length > 0 || Voice.hasHistory();
  }

  /* ---- saving and resuming a session ---- */

  /**
   * This session as something that could be written down, or null when
   * there is nothing worth writing.
   *
   * Two modes can hold a conversation and only one draft is kept per
   * case, so this has to choose. The mode on screen wins if it has
   * anything in it, because that is the one being worked; otherwise
   * whichever of the two does. Both being full at once is real —
   * switching modes mid-case leaves the first one intact — and the
   * alternative to choosing would be a draft that resumes into a mode
   * the detective wasn't in.
   *
   * Scored dots are deliberately absent. They are ScoreModal's, they
   * already persist through the normal Close the Case path, and a
   * resume draft that could carry a score would be a second way to
   * write XP — which is exactly the thing this feature must not become.
   */
  function snapshot() {
    const voice = Voice.history();
    const held = { text: transcript, voice };

    const preferred = held[mode] && held[mode].length ? mode : null;
    const fallback = transcript.length ? "text" : voice.length ? "voice" : null;
    const saved = preferred || fallback;

    return saved ? { mode: saved, messages: held[saved] } : null;
  }

  /**
   * Put a saved session back on screen, in the mode it was saved in.
   *
   * `choose` does the mode switch exactly as a click would, so the
   * resumed case is in the same state as one worked from scratch —
   * nothing here special-cases a resumed session afterwards. It runs
   * first because the two modes need opposite things from it: text
   * needs the stage visible before bubbles can be appended to it, and
   * voice needs `attach` to have created a session for `seed` to fill.
   *
   * Blocked access is a real outcome here, not an error. The draft is
   * still restored and still readable; what a detective at their cap
   * loses is the ability to add another turn, which is the same thing
   * they'd lose starting fresh.
   */
  function restore(draft, onDiscard) {
    if (!draft || !draft.messages.length) return false;

    choose(draft.mode);

    if (draft.mode === "text") {
      transcript = draft.messages.map((m) => ({ role: m.role, content: m.content }));
      // Cleared first because `choose` seeds an opening hint into an
      // empty log, and a resumed conversation is not being started.
      document.getElementById("chat-log").innerHTML = "";
      transcript.forEach((turn) => say(turn.role, turn.content));
    } else {
      Voice.seed(draft.messages);
    }

    // Whether the conversation is actually back on screen, or only
    // still on the server. `choose` declines to attach a Live Voice
    // session when the browser has no speech engine or the cap is
    // spent, and there is then nothing for `seed` to fill — so the bar
    // has to say which of the two happened rather than claiming a
    // resume that didn't take. Nothing is lost either way: the draft is
    // untouched and opens on a browser that can hold it.
    const carried = draft.mode === "text" || Voice.attached();

    // Held rather than called: this is the only way back out of a
    // resumed session, and the bar offering it is on screen for as long
    // as the resumed session is.
    discardDraft = onDiscard || null;
    showResumeBar(draft, carried);
    return carried;
  }

  /**
   * The way out of a resumed session: throw the draft away and work the
   * case from nothing.
   *
   * The discard itself is a callback handed in by whoever restored the
   * draft. Practice knows what a session is and how to clear one; it
   * has no business knowing that drafts are stored anywhere, let alone
   * deleting rows.
   */
  function startFresh() {
    const discard = discardDraft;
    reset(question);
    if (discard) discard();
  }

  /**
   * The one line that says this conversation was resumed, and offers
   * not to be.
   *
   * Auto-resuming is the right default — it is what "save my session"
   * promised — but a draft from three weeks ago silently reappearing
   * under a question you meant to answer cold is a trap without this.
   * It sits above the practice note rather than replacing it, because
   * the note is still carrying the budget or a refusal and both facts
   * are worth having at once.
   */
  function showResumeBar(draft, carried) {
    const bar = document.getElementById("practice-resume");
    const label = draft.mode === "voice" ? "Live Voice" : "Text Practice";
    const turns = draft.messages.filter((m) => m.role === "user").length;
    const answers = `${turns} answer${turns === 1 ? "" : "s"} in`;

    document.getElementById("practice-resume-text").textContent = carried
      ? `Resumed your saved ${label} session — ${answers}.`
      : `You have a saved ${label} session here — ${answers}. It'll load when this mode can run.`;
    bar.hidden = false;
  }

  return { init, reset, dismiss, hasProgress, snapshot, restore, startFresh };
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
 *
 * The modal has two states, not two purposes. Collapsed it signs a
 * detective in; expanded it also mints invite codes for whoever holds
 * ADMIN_TOKEN. They share a box and nothing else — no field, no
 * submit path, no error line — because a mistyped admin token must not
 * be able to change who signs in, and vice versa. `Minting` below owns
 * the expanded half entirely.
 */
const Login = (() => {
  function init() {
    document.getElementById("nav-identity").addEventListener("click", onIdentityClick);
    document.getElementById("login-submit").addEventListener("click", submit);
    document.getElementById("login-cancel").addEventListener("click", close);
    document.getElementById("login-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    document.getElementById("login-code").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    document.getElementById("login-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "login-modal-backdrop") close();
    });

    Minting.init();
    renderBadge();
  }

  /** Signed out opens the modal; signed in offers to sign out. */
  function onIdentityClick() {
    if (!Identity.isSignedIn()) {
      open();
      return;
    }
    if (confirm(`Sign out of ${Identity.username()}? That log stays synced to the account — this device goes back to its own.`)) {
      Identity.clear();
      // Saved sessions belong to the account, not the device, and
      // unlike the log there is no signed-out slot for them to fall
      // back to. Cleared rather than re-fetched: there is nobody to
      // fetch them for, and leaving the badges up would offer to resume
      // a conversation this device can no longer read.
      Drafts.clear();
      renderBadge();
      // The badge is not the only thing that just changed meaning. Every
      // panel on the page — rank, XP bar, per-case scores, the log table
      // — is drawn from Storage.getLog(), and getLog() now answers from a
      // different slot than it did a line ago. Redrawing only the badge
      // is what left the previous detective's entries on screen.
      Render.all();
    }
  }

  function open() {
    setError("");
    const input = document.getElementById("login-input");
    input.value = "";
    document.getElementById("login-code").value = "";
    // Reopening always lands on the sign-in state. The minting panel is
    // rare enough that leaving it hanging open from last time would be a
    // surprise, and it holds an admin token that shouldn't outlive the
    // moment it was needed.
    Minting.collapse();
    document.getElementById("login-modal-backdrop").classList.add("open");
    BodyScroll.lock();
    input.focus();
  }

  function close() {
    document.getElementById("login-modal-backdrop").classList.remove("open");
    BodyScroll.unlock();
    Minting.collapse();
  }

  async function submit() {
    const button = document.getElementById("login-submit");
    const name = document.getElementById("login-input").value.trim();
    // Blank is the normal case, not a missing answer: no code means the
    // free tier, which is a complete way to use the site.
    const code = document.getElementById("login-code").value.trim();

    if (!name) {
      setError("Every detective needs a name.");
      return;
    }

    button.disabled = true;
    button.textContent = "CHECKING…";

    try {
      await Api.signIn(name, code);
      close();
      renderBadge();
      // The sign-in response already carried the server log; a refresh
      // merges it with anything practised on this device beforehand.
      if (await Storage.refresh()) {
        Render.all();
      }
      // This account's saved sessions, which are nothing to do with
      // whoever was signed in a moment ago. Not awaited alongside the
      // log: badges are decoration and must not hold the modal open.
      Drafts.refresh().then((changed) => {
        if (changed) Render.caseGrid();
      });
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
    badge.title = name
      ? `Synced to Cloudflare · ${tierLabel()} — click to sign out`
      : "Sync your progress across devices";
  }

  /** The tier, in the one place it's worth stating outside the case modal. */
  function tierLabel() {
    const access = Identity.access();
    if (access.tier === "owner") {
      return "AI practice unlimited";
    }
    if (access.tier === "invited") {
      return access.ai
        ? `AI practice $${Number(access.remaining).toFixed(2)} left`
        : "AI practice — limit reached";
    }
    return "manual scoring & Send to Claude";
  }

  return { init, renderBadge };
})();

/* ---------------------------------------------------------- */
/* 8. MINTING                                                   */
/* ---------------------------------------------------------- */

/**
 * The login modal's other state: making invite codes.
 *
 * Behind a toggle rather than always visible, because it is for one
 * person and everyone else opening this modal wants the codename field.
 * In the same modal rather than an /admin page, because a second page
 * would be a second thing to route, style, and remember exists — for a
 * form with two fields that gets used a handful of times.
 *
 * It shares no state with signing in. Not the fields, not the error
 * line, not the submit path. That separation is the whole reason this
 * can live inside the login modal without making signing in riskier:
 * there is no sequence of keystrokes here that changes who logs in.
 *
 * The admin token is never stored. It lives in the input, is passed
 * straight to the request, and is wiped when the panel closes. Holding
 * it in a module variable "for convenience" would mean the one
 * credential that can spend money outlives the thirty seconds it was
 * needed for.
 */
const Minting = (() => {
  // Which of the two operations the panel is currently pointed at.
  // "mint" | "revoke" — they share the admin token field and nothing else.
  let op = "mint";

  function init() {
    document.getElementById("admin-toggle").addEventListener("click", toggle);
    document.getElementById("admin-generate").addEventListener("click", run);
    document.getElementById("admin-copy").addEventListener("click", copy);

    document.getElementById("admin-tabs").addEventListener("click", (e) => {
      const tab = e.target.closest(".admin-tab");
      if (tab) choose(tab.dataset.op);
    });

    document.getElementById("admin-revoke-all").addEventListener("click", arm);
    document.getElementById("admin-confirm-cancel").addEventListener("click", disarm);
    document.getElementById("admin-confirm-yes").addEventListener("click", revokeAll);

    // Enter inside the panel runs the current operation; it must never
    // fall through to the sign-in button sitting a few pixels above it.
    ["admin-token", "admin-cap", "admin-revoke-code"].forEach((id) => {
      document.getElementById(id).addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        run();
      });
    });
  }

  /**
   * Point the panel at one of the two operations.
   *
   * Switching clears the error and the result, because both belong to
   * the operation that produced them — a "revoked" confirmation still on
   * screen under a Generate button would be describing something that
   * has nothing to do with the button. The admin token survives the
   * switch; it is the one field both operations share.
   */
  function choose(next) {
    if (next === op) {
      return;
    }
    op = next;

    document.querySelectorAll(".admin-tab").forEach((tab) => {
      const on = tab.dataset.op === op;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", String(on));
    });

    document.getElementById("admin-mint-field").hidden = op !== "mint";
    document.getElementById("admin-revoke-field").hidden = op !== "revoke";
    document.getElementById("admin-bulk").hidden = op !== "revoke";
    disarm();

    const button = document.getElementById("admin-generate");
    button.textContent = op === "mint" ? "GENERATE" : "REVOKE";
    button.classList.toggle("admin-danger", op === "revoke");

    setError("");
    document.getElementById("admin-result").hidden = true;

    // Only when there is something to focus. `collapse` resets the tab
    // back to Generate on the way out, and pulling focus into a field
    // inside a panel that is being hidden would scroll the modal for no
    // reason the reader can see.
    if (!document.getElementById("admin-panel").hidden) {
      document.getElementById(op === "mint" ? "admin-cap" : "admin-revoke-code").focus();
    }
  }

  function toggle() {
    const panel = document.getElementById("admin-panel");
    if (panel.hidden) {
      expand();
    } else {
      collapse();
    }
  }

  function expand() {
    document.getElementById("admin-panel").hidden = false;
    document.getElementById("admin-toggle").setAttribute("aria-expanded", "true");
    document.getElementById("admin-toggle").textContent = "Hide beta code panel";
    document.getElementById("admin-token").focus();
  }

  /**
   * Shut the panel and forget everything in it.
   *
   * Called on close and on reopen as well as on the toggle, so there is
   * no path that leaves an admin token sitting in a field behind a
   * dismissed modal. Clearing the result too: a code that has already
   * been written down is clutter, and one that hasn't is a row in D1
   * either way — showing it again later would suggest otherwise.
   */
  function collapse() {
    document.getElementById("admin-panel").hidden = true;
    document.getElementById("admin-toggle").setAttribute("aria-expanded", "false");
    document.getElementById("admin-toggle").textContent = "Generate beta code";
    document.getElementById("admin-token").value = "";
    document.getElementById("admin-revoke-code").value = "";
    document.getElementById("admin-result").hidden = true;
    setError("");
    choose("mint");
  }

  /**
   * Run whichever operation the panel is pointed at.
   *
   * One entry point for the button and for Enter, so there is no way to
   * reach `revoke` from a panel that is showing `mint` — the operation
   * is read from state at the moment of the call rather than baked into
   * whichever listener happened to fire.
   */
  function run() {
    return op === "mint" ? generate() : revoke();
  }

  async function generate() {
    const token = adminToken();
    if (!token) {
      return;
    }

    const cap = Number(document.getElementById("admin-cap").value);

    // Checked here as well as in the Worker, which clamps it. The Worker
    // is the one that counts; this is so a typed "5oo" is a sentence on
    // screen rather than a code silently minted at the default cap.
    if (!Number.isFinite(cap) || cap <= 0 || cap > 100) {
      setError("Give the cap a dollar amount between 0.05 and 100.");
      return;
    }

    await attempt("admin-generate", "MINTING…", async () => {
      const minted = await Api.mintCode(token, cap);
      show(
        minted.code,
        `New code — $${money(minted.cap_usd)} of AI coaching, shared by everyone who uses it.`
      );
    });
  }

  /**
   * Switch a code off.
   *
   * No confirm() step. The action is reversible in one PATCH — raising
   * the cap or setting active back on revives it — and nothing is
   * destroyed: spend, turns and everyone's case files survive. A modal
   * asking "are you sure" would be protecting against an outcome that
   * costs one more click to undo.
   */
  async function revoke() {
    const token = adminToken();
    if (!token) {
      return;
    }

    const code = document.getElementById("admin-revoke-code").value.trim();
    if (!code) {
      setError("Which code? Paste the one to switch off.");
      return;
    }

    await attempt("admin-generate", "REVOKING…", async () => {
      const { code: revoked, wasActive } = await Api.revokeCode(token, code);

      // Reporting the no-op honestly. Switching off a code that was
      // already off changed nothing, and saying "revoked" would tell
      // someone they had just cut access that had been cut for a week.
      const spend = `It had spent $${money(revoked.spent_usd)} of $${money(revoked.cap_usd)} across ${revoked.turns} turn${revoked.turns === 1 ? "" : "s"}.`;

      show(
        revoked.code,
        wasActive
          ? `Revoked. AI coaching stops on the next turn. ${spend}`
          : `Already revoked — nothing changed. ${spend}`
      );
      document.getElementById("admin-revoke-code").value = "";
    });
  }

  /* ---- bulk revoke: two steps, on purpose ---- */

  /**
   * Show the confirmation and hide the button that opened it.
   *
   * Swapping rather than stacking, so there is never a moment where two
   * buttons that both say "revoke all" are on screen at once and the
   * wrong one is one pixel away.
   */
  function arm() {
    setError("");
    document.getElementById("admin-revoke-all").hidden = true;
    document.getElementById("admin-confirm").hidden = false;
    document.getElementById("admin-confirm-yes").focus();
  }

  /**
   * Put the confirmation away.
   *
   * Called on cancel, on switching tabs, on closing the modal, and after
   * the operation runs — an armed destructive action must not survive
   * the moment it was armed in, least of all behind a closed modal that
   * reopens looking ready to fire.
   */
  function disarm() {
    document.getElementById("admin-revoke-all").hidden = false;
    document.getElementById("admin-confirm").hidden = true;
  }

  async function revokeAll() {
    const token = adminToken();
    if (!token) {
      disarm();
      return;
    }

    await attempt("admin-confirm-yes", "REVOKING…", async () => {
      const revoked = await Api.revokeAllCodes(token);
      show(
        "",
        revoked === 0
          ? "Nothing to revoke — every invite code was already switched off."
          : `Revoked ${revoked} invite code${revoked === 1 ? "" : "s"}. AI coaching stops for all of them on the next turn.`
      );
    });

    // After the run either way: a confirmation left armed invites a
    // second press that would report "nothing to revoke" and read like
    // the first one silently failed.
    disarm();
  }

  /** The shared credential, or "" with the error already on screen. */
  function adminToken() {
    const token = document.getElementById("admin-token").value.trim();
    if (!token) {
      setError("The admin token is the whole check — nothing happens without it.");
      return "";
    }
    setError("");
    return token;
  }

  /**
   * The bits both operations do the same way: disable the button, run,
   * and put the button back whatever happened. Worth factoring out
   * precisely because the `finally` is the part that is easy to forget
   * in the second copy, and forgetting it leaves the panel dead.
   */
  async function attempt(buttonId, busyLabel, work) {
    const button = document.getElementById(buttonId);
    const label = button.textContent;

    button.disabled = true;
    button.textContent = busyLabel;

    try {
      await work();
    } catch (err) {
      document.getElementById("admin-result").hidden = true;
      setError(err.message);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  /**
   * Report what happened. `code` is the one this concerned, or "" when
   * the operation had no single subject — revoking everything names no
   * code, and an empty monospace slot sitting there would read as one
   * that failed to load.
   */
  function show(code, message) {
    const result = document.getElementById("admin-result");
    document.getElementById("admin-code").textContent = code;
    document.getElementById("admin-code").hidden = !code;
    document.getElementById("admin-result-label").textContent = message;
    result.hidden = false;
    document.getElementById("admin-copy").textContent = "Copy";
    // Copying a code you just switched off is a button that does nothing
    // useful; the string is still selectable if it's wanted.
    document.getElementById("admin-copy").hidden = op !== "mint" || !code;

    // The result is the last thing in a modal that now scrolls, so on a
    // short window it lands below the fold — which is indistinguishable
    // from nothing having happened, and is exactly how a working revoke
    // came to look like a broken one.
    result.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function money(usd) {
    return Number(usd || 0).toFixed(2);
  }

  /**
   * Convenience only. The code is on screen and selectable, so a browser
   * that blocks the clipboard costs a manual select rather than the code.
   */
  async function copy() {
    const button = document.getElementById("admin-copy");
    try {
      await navigator.clipboard.writeText(document.getElementById("admin-code").textContent);
      button.textContent = "Copied";
    } catch (err) {
      button.textContent = "Select it manually";
    }
  }

  function setError(message) {
    document.getElementById("admin-error").textContent = message;
  }

  return { init, collapse };
})();

/* ---------------------------------------------------------- */
/* 9. BOOTSTRAP                                                 */
/* ---------------------------------------------------------- */

function bootstrap() {
  Render.all();
  Views.init();
  Login.init();
  Practice.init();
  ExitConfirm.init();

  // Returning detectives sync silently — no modal, no spinner, no wait.
  Storage.refresh().then((changed) => {
    if (changed) Render.all();
    // A refresh can drop an expired session, so the badge is re-read.
    Login.renderBadge();
  });

  // Which cases have something to come back to. Its own request rather
  // than part of the log sync: the log is the site's whole state and is
  // read synchronously by four panels, while this decorates one of them
  // and can arrive whenever it arrives.
  Drafts.refresh().then((changed) => {
    if (changed) Render.caseGrid();
  });

  // The stored tier is from whenever this device last signed in, and a
  // cap can be raised or a code revoked in between. Re-reading it on load
  // is what stops a tab left open overnight showing yesterday's answer.
  Api.refreshAccess().then((access) => {
    if (access) Login.renderBadge();
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
  // The leave-the-case dialog gets first refusal when it's the thing on
  // top, then an open menu, so Escape always dismisses whatever the
  // detective is actually looking at rather than reaching past it.
  // Escape there means Cancel, like the backdrop — it is the answer that
  // loses nothing.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (ExitConfirm.isOpen()) {
      ExitConfirm.close();
      return;
    }
    if (Practice.dismiss()) return;
    ScoreModal.close();
  });

  // A raw confirm() ran the same check but looked like the browser
  // rather than the case file, and habit clicks past those without
  // reading them. This one is a modal like every other decision point
  // on the page, so dismissing it takes noticing it first.
  document.getElementById("reset-btn").addEventListener("click", () => {
    document.getElementById("reset-modal-backdrop").classList.add("open");
    BodyScroll.lock();
  });
  document.getElementById("reset-cancel").addEventListener("click", closeResetModal);
  document.getElementById("reset-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "reset-modal-backdrop") closeResetModal();
  });
  document.getElementById("reset-confirm").addEventListener("click", () => {
    Storage.clearLog();
    Render.all();
    closeResetModal();
  });

  function closeResetModal() {
    document.getElementById("reset-modal-backdrop").classList.remove("open");
    BodyScroll.unlock();
  }
}

// Guard against sandboxed/iframe environments where the document may
// already be parsed by the time this script runs (DOMContentLoaded
// would never fire in that case).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
