/* ==========================================================================
   Español SRS — SM-2 based spaced repetition flashcard app
   All state persisted in localStorage. No backend required.
   ========================================================================== */

const LS_PROGRESS = "esrs_progress_v1";   // { [cardId]: {reps, interval, ef, due, lapses} }
const LS_SETTINGS = "esrs_settings_v1";   // { newPerDay }
const LS_STATS    = "esrs_stats_v1";      // { streak, lastStudyDay, totalReviews, history: {date: count} }

const DAY_MS = 24 * 60 * 60 * 1000;

const defaultSettings = { newPerDay: 20 };

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

let DATA = [];                     // full vocabulary dataset
let progress = loadJSON(LS_PROGRESS, {});
let settings = Object.assign({}, defaultSettings, loadJSON(LS_SETTINGS, {}));
let stats = loadJSON(LS_STATS, { streak: 0, lastStudyDay: null, totalReviews: 0, history: {} });

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// SM-2 scheduling
// ---------------------------------------------------------------------------
// quality: "again" | "hard" | "good" | "easy"
function getCardState(id) {
  return progress[id] || { reps: 0, interval: 0, ef: 2.5, due: 0, lapses: 0 };
}

function previewIntervals(id) {
  const st = getCardState(id);
  return {
    again: "10m",
    hard: formatInterval(nextInterval(st, "hard").interval),
    good: formatInterval(nextInterval(st, "good").interval),
    easy: formatInterval(nextInterval(st, "easy").interval),
  };
}

function formatInterval(days) {
  if (days < 1) return Math.round(days * 24 * 60) + "m";
  if (days < 30) return Math.round(days) + "d";
  if (days < 365) return Math.round(days / 30 * 10) / 10 + "mo";
  return Math.round(days / 365 * 10) / 10 + "y";
}

// Core SM-2-derived transition. Returns {reps, interval, ef}
function nextInterval(st, quality) {
  let { reps, interval, ef } = st;
  ef = ef || 2.5;

  if (quality === "again") {
    return { reps: 0, interval: 1, ef: Math.max(1.3, ef - 0.2) };
  }

  if (quality === "hard") {
    const newEf = Math.max(1.3, ef - 0.15);
    // Keep interval un-rounded internally so repeated "Hard" answers still
    // grow over time instead of getting stuck at 1 day.
    const newInterval = reps === 0 ? 1 : Math.max(interval + 0.5, interval * 1.2);
    return { reps: reps + 1, interval: newInterval, ef: newEf };
  }

  // "good" or "easy" use classic SM-2 progression
  const q = quality === "easy" ? 5 : 4;
  let newEf = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  newEf = Math.max(1.3, newEf);

  let newInterval;
  if (reps === 0) newInterval = 1;
  else if (reps === 1) newInterval = 6;
  else newInterval = interval * newEf;

  if (quality === "easy") newInterval = newInterval * 1.3;

  return { reps: reps + 1, interval: newInterval, ef: newEf };
}

function applyRating(id, quality) {
  const st = getCardState(id);
  const result = nextInterval(st, quality);
  const now = Date.now();
  const dueOffset = quality === "again" ? (10 * 60 * 1000) : (result.interval * DAY_MS);
  progress[id] = {
    reps: result.reps,
    interval: result.interval,
    ef: result.ef,
    due: now + dueOffset,
    lapses: (st.lapses || 0) + (quality === "again" ? 1 : 0),
  };
  saveJSON(LS_PROGRESS, progress);

  stats.totalReviews += 1;
  const t = todayStr();
  stats.history[t] = (stats.history[t] || 0) + 1;
  updateStreak();
  saveJSON(LS_STATS, stats);
}

function updateStreak() {
  const t = todayStr();
  if (stats.lastStudyDay === t) return; // already counted today
  const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  if (stats.lastStudyDay === yesterday) {
    stats.streak += 1;
  } else {
    stats.streak = 1;
  }
  stats.lastStudyDay = t;
}

// ---------------------------------------------------------------------------
// Queue building
// ---------------------------------------------------------------------------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getDueCards() {
  const now = Date.now();
  return DATA.filter(c => progress[c.id] && progress[c.id].due <= now);
}

function getNewCards() {
  return DATA.filter(c => !progress[c.id]);
}

function buildSession() {
  const due = shuffle(getDueCards());
  const remainingNewBudget = Math.max(0, settings.newPerDay - getTodayNewCount());
  const newCards = shuffle(getNewCards()).slice(0, remainingNewBudget);
  // interleave: a few due, then a new, repeating
  const queue = [];
  let di = 0, ni = 0;
  while (di < due.length || ni < newCards.length) {
    for (let k = 0; k < 3 && di < due.length; k++) queue.push(due[di++]);
    if (ni < newCards.length) queue.push(newCards[ni++]);
  }
  return queue;
}

function getTodayNewCount() {
  const t = todayStr();
  return Object.values(progress).filter(p => p.firstSeen === t).length;
}

// ---------------------------------------------------------------------------
// Audio playback
// ---------------------------------------------------------------------------
let audioEl = null;
let audioStopAt = null;

function playCardAudio(card) {
  if (!card.cycle || card.audio_start == null) return;
  const src = `audio/Cycle ${card.cycle}.mp3`;
  if (!audioEl || audioEl.dataset.src !== src) {
    if (audioEl) audioEl.pause();
    audioEl = new Audio(src);
    audioEl.dataset.src = src;
    audioEl.addEventListener("timeupdate", () => {
      if (audioStopAt != null && audioEl.currentTime >= audioStopAt) {
        audioEl.pause();
        audioStopAt = null;
      }
    });
  }
  audioStopAt = card.audio_end + 0.3;
  audioEl.currentTime = card.audio_start;
  audioEl.play();
}

// ---------------------------------------------------------------------------
// App state / navigation
// ---------------------------------------------------------------------------
const screens = {};
let currentQueue = [];
let currentIndex = 0;
let currentCard = null;
let sessionReviewed = 0;

function show(screenId) {
  Object.values(screens).forEach(s => s.classList.add("hidden"));
  screens[screenId].classList.remove("hidden");
}

function $(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------------
// Home screen rendering
// ---------------------------------------------------------------------------
function renderHome() {
  const due = getDueCards().length;
  const newBudget = Math.max(0, settings.newPerDay - getTodayNewCount());
  const newAvail = Math.min(getNewCards().length, newBudget);

  $("stat-due").textContent = due;
  $("stat-new").textContent = newAvail;
  $("stat-streak").textContent = stats.streak || 0;

  const learned = Object.values(progress).filter(p => p.reps >= 1).length;
  $("stat-learned").textContent = learned;

  const pct = DATA.length ? Math.round((learned / DATA.length) * 100) : 0;
  $("progress-pct").textContent = pct + "%";
  $("progress-fill").style.width = pct + "%";

  $("btn-start").disabled = (due + newAvail) === 0;
  $("btn-start").textContent = (due + newAvail) === 0 ? "All caught up! 🎉" : "Start Review";
}

// ---------------------------------------------------------------------------
// Review session
// ---------------------------------------------------------------------------
function startSession() {
  currentQueue = buildSession();
  currentIndex = 0;
  sessionReviewed = 0;
  if (currentQueue.length === 0) {
    renderHome();
    return;
  }
  show("screen-review");
  nextCard();
}

function nextCard() {
  if (currentIndex >= currentQueue.length) {
    finishSession();
    return;
  }
  currentCard = currentQueue[currentIndex];
  renderCard(currentCard);
  updateReviewProgress();
}

function renderCard(card) {
  const flip = $("card");
  flip.classList.remove("flipped");
  $("rating-row").classList.add("hidden");
  $("tap-hint").classList.remove("hidden");

  $("card-cat").textContent = card.cat;
  $("card-cat-back").textContent = card.cat;
  $("card-term").textContent = card.es;
  $("card-emoji").textContent = card.emoji || "";
  $("card-definition").textContent = card.def || "";
  $("card-example").textContent = card.x || "";

  const imgLink = $("card-image-link");
  imgLink.href = "https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(card.es);
  imgLink.classList.toggle("hidden", !!card.emoji);

  const audioBtn = $("card-audio-btn");
  if (audioBtn) {
    audioBtn.classList.toggle("hidden", !card.audio_start);
  }

  const iv = previewIntervals(card.id);
  $("iv-again").textContent = iv.again;
  $("iv-hard").textContent = iv.hard;
  $("iv-good").textContent = iv.good;
  $("iv-easy").textContent = iv.easy;
}

function flipCard() {
  $("card").classList.add("flipped");
  $("rating-row").classList.remove("hidden");
  $("tap-hint").classList.add("hidden");
}

function rate(quality) {
  const id = currentCard.id;
  const wasNew = !progress[id];
  applyRating(id, quality);
  if (wasNew) {
    progress[id].firstSeen = todayStr();
    saveJSON(LS_PROGRESS, progress);
  }
  sessionReviewed++;

  // "Again" cards get requeued a few positions later in this same session
  if (quality === "again") {
    const reinsertAt = Math.min(currentQueue.length, currentIndex + 4);
    currentQueue.splice(reinsertAt, 0, currentCard);
  }

  currentIndex++;
  nextCard();
}

function updateReviewProgress() {
  const total = currentQueue.length;
  const done = currentIndex;
  $("review-progress-fill").style.width = (total ? (done / total) * 100 : 100) + "%";
  $("review-remaining").textContent = Math.max(0, total - done);
}

function finishSession() {
  $("done-summary").textContent = `You reviewed ${sessionReviewed} card${sessionReviewed === 1 ? "" : "s"}. ¡Buen trabajo!`;
  show("screen-done");
}

// ---------------------------------------------------------------------------
// Browse screen
// ---------------------------------------------------------------------------
let activeCategory = "all";

function cardStatus(card) {
  const p = progress[card.id];
  if (!p) return { cls: "bs-new", label: "New" };
  if (p.reps >= 1 && p.interval >= 21) return { cls: "bs-mastered", label: "Mastered" };
  return { cls: "bs-learning", label: "Learning" };
}

function renderCategoryChips() {
  const cats = Array.from(new Set(DATA.map(c => c.cat)));
  const wrap = $("category-chips");
  wrap.innerHTML = "";
  const all = document.createElement("div");
  all.className = "chip" + (activeCategory === "all" ? " active" : "");
  all.textContent = "All";
  all.onclick = () => { activeCategory = "all"; renderCategoryChips(); renderBrowseList(); };
  wrap.appendChild(all);
  cats.forEach(cat => {
    const chip = document.createElement("div");
    chip.className = "chip" + (activeCategory === cat ? " active" : "");
    chip.textContent = cat;
    chip.onclick = () => { activeCategory = cat; renderCategoryChips(); renderBrowseList(); };
    wrap.appendChild(chip);
  });
}

function renderBrowseList() {
  const q = $("browse-search").value.trim().toLowerCase();
  const list = $("browse-list");
  list.innerHTML = "";
  const filtered = DATA.filter(c => {
    if (activeCategory !== "all" && c.cat !== activeCategory) return false;
    if (q && !c.es.toLowerCase().includes(q) && !c.en.toLowerCase().includes(q)) return false;
    return true;
  }).slice(0, 300); // cap render for performance

  filtered.forEach(c => {
    const status = cardStatus(c);
    const item = document.createElement("div");
    item.className = "browse-item";
    item.innerHTML = `
      <div>
        <div class="b-es">${escapeHtml(c.es)}</div>
        <div class="b-en">${escapeHtml(c.en)}</div>
      </div>
      <div class="browse-status ${status.cls}">${status.label}</div>
    `;
    list.appendChild(item);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------
function renderSettings() {
  $("setting-new-per-day").value = settings.newPerDay;
}

function saveSettings() {
  settings.newPerDay = parseInt($("setting-new-per-day").value, 10) || defaultSettings.newPerDay;
  saveJSON(LS_SETTINGS, settings);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  screens["screen-home"] = $("screen-home");
  screens["screen-review"] = $("screen-review");
  screens["screen-done"] = $("screen-done");
  screens["screen-browse"] = $("screen-browse");
  screens["screen-settings"] = $("screen-settings");

  const res = await fetch("data.json");
  DATA = await res.json();

  renderHome();

  $("btn-start").addEventListener("click", startSession);
  $("btn-exit-review").addEventListener("click", () => { show("screen-home"); renderHome(); });
  $("card").addEventListener("click", () => {
    if (!$("card").classList.contains("flipped")) flipCard();
  });
  document.querySelectorAll(".rate-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      rate(btn.dataset.q);
    });
  });
  $("btn-done-home").addEventListener("click", () => { show("screen-home"); renderHome(); });
  $("card-audio-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    playCardAudio(currentCard);
  });

  $("btn-browse").addEventListener("click", () => {
    show("screen-browse");
    renderCategoryChips();
    renderBrowseList();
  });
  $("btn-browse-back").addEventListener("click", () => { show("screen-home"); renderHome(); });
  $("browse-search").addEventListener("input", renderBrowseList);

  $("btn-settings").addEventListener("click", () => { renderSettings(); show("screen-settings"); });
  $("btn-settings-back").addEventListener("click", () => {
    saveSettings();
    show("screen-home");
    renderHome();
  });
  $("setting-new-per-day").addEventListener("change", saveSettings);

  $("btn-reset-progress").addEventListener("click", () => {
    if (confirm("Reset all progress? This cannot be undone.")) {
      progress = {};
      stats = { streak: 0, lastStudyDay: null, totalReviews: 0, history: {} };
      saveJSON(LS_PROGRESS, progress);
      saveJSON(LS_STATS, stats);
      show("screen-home");
      renderHome();
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
