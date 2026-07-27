/**
 * app.js
 * ------------------------------------------------------------
 * Case Files interview practice tracker.
 *
 * Structure:
 *   1. Storage layer   - persistence (localStorage), no DOM/UI knowledge
 *   2. Rank logic       - pure functions, no side effects
 *   3. Render layer     - DOM writes only, reads state, no calculations
 *   4. Event wiring     - glues user actions to state + render
 *
 * Kept intentionally framework-free and single-file per concern
 * so the whole thing stays readable without a build step.
 * ------------------------------------------------------------
 */

/* ---------------------------------------------------------- */
/* 1. STORAGE LAYER                                            */
/* ---------------------------------------------------------- */

const Storage = (() => {
  const KEY = "caseFiles.log.v1";

  function getLog() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error("Storage read failed:", err);
      return [];
    }
  }

  function saveEntry(entry) {
    const log = getLog();
    log.push(entry);
    try {
      localStorage.setItem(KEY, JSON.stringify(log));
    } catch (err) {
      console.error("Storage write failed:", err);
    }
    return log;
  }

  function clearLog() {
    localStorage.removeItem(KEY);
  }

  return { getLog, saveEntry, clearLog };
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

    document.getElementById("case-modal-backdrop").classList.add("open");
  }

  function close() {
    document.getElementById("case-modal-backdrop").classList.remove("open");
    activeCase = null;
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
          group.querySelectorAll(".dot").forEach((d) => {
            d.classList.toggle("selected", Number(d.dataset.value) <= scores[key]);
          });
          updateTotal();
        });
      });
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

    const entry = {
      caseId: activeCase.id,
      questionShort: activeCase.question.slice(0, 40) + (activeCase.question.length > 40 ? "…" : ""),
      date: new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
      rawScore: raw,
      bonus,
      xp,
    };

    Storage.saveEntry(entry);
    close();
    Render.all();
  }

  return { open, close, submit };
})();

/* ---------------------------------------------------------- */
/* 5. VIEW SWITCHING                                            */
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
/* 6. BOOTSTRAP                                                 */
/* ---------------------------------------------------------- */

function bootstrap() {
  Render.all();
  Views.init();

  document.getElementById("case-grid").addEventListener("click", (e) => {
    const card = e.target.closest(".case-card");
    if (card) ScoreModal.open(Number(card.dataset.caseId));
  });

  document.getElementById("modal-close").addEventListener("click", ScoreModal.close);
  document.getElementById("case-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "case-modal-backdrop") ScoreModal.close();
  });
  document.getElementById("submit-score").addEventListener("click", ScoreModal.submit);

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

// Recalculate modal total whenever the bonus checkbox changes
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "bonus-check") {
    const totalEl = document.getElementById("modal-total-xp");
    const current = Array.from(document.querySelectorAll(".score-dots"))
      .reduce((sum, group) => {
        const selected = group.querySelectorAll(".dot.selected").length;
        return sum + selected;
      }, 0);
    const bonus = e.target.checked ? 5 : 0;
    totalEl.textContent = current + bonus;
  }
});
