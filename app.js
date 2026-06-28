const LS_USER = "esrs_user_v2";
const LS_PROGRESS_V1 = "esrs_progress_v1";
const LS_SETTINGS_V1 = "esrs_settings_v1";
const LS_STATS_V1 = "esrs_stats_v1";
const LS_CYCLE_V1 = "esrs_current_cycle_v1";

const DAY_MS = 24 * 60 * 60 * 1000;
const defaultSettings = { new_per_day: 20 };

function loadJSON(key, fallback) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
  catch(e) { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
}
function fmtTime(secs) {
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return m + ":" + String(s).padStart(2, "0");
}

let DATA = [];
let CYCLES_META = [];
let CYCLE_DATA = { segments: {}, words: {} };
let CONTENT = null;
const existingUser = loadJSON(LS_USER, null);
let user = existingUser || {
  schema_version: 2,
  cards: {},
  review_events: [],
  lesson_progress: {},
  settings: Object.assign({}, defaultSettings),
  stats: { streak: 0, last_study_day: null, total_reviews: 0, history: {} },
  current_lesson_id: "lesson:fsi:03",
};
let progress = user.cards;
let settings = Object.assign({}, defaultSettings, user.settings || {});
let stats = Object.assign(
  { streak: 0, last_study_day: null, total_reviews: 0, history: {} },
  user.stats || {}
);
let currentCycleNum = parseInt((user.current_lesson_id || "lesson:fsi:03").split(":").pop(), 10) || 3;

function saveUser() {
  user.cards = progress;
  user.settings = settings;
  user.stats = stats;
  user.current_lesson_id = `lesson:fsi:${String(currentCycleNum).padStart(2, "0")}`;
  saveJSON(LS_USER, user);
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// SM-2
// ---------------------------------------------------------------------------
function getCardState(id) {
  return progress[id] || {
    in_deck: true,
    reps: 0,
    interval: 0,
    ease_factor: 2.5,
    due_at: 0,
    lapses: 0,
    first_seen_on: null,
  };
}
function formatInterval(days) {
  if (days < 1) return Math.round(days * 24 * 60) + "m";
  if (days < 30) return Math.round(days) + "d";
  if (days < 365) return Math.round(days / 30 * 10) / 10 + "mo";
  return Math.round(days / 365 * 10) / 10 + "y";
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
function nextInterval(st, quality) {
  let { reps, interval } = st;
  let ease_factor = st.ease_factor || 2.5;
  if (quality === "again") return { reps: 0, interval: 1, ease_factor: Math.max(1.3, ease_factor - 0.2) };
  if (quality === "hard") {
    return { reps: reps + 1, interval: reps === 0 ? 1 : Math.max(interval + 0.5, interval * 1.2), ease_factor: Math.max(1.3, ease_factor - 0.15) };
  }
  const q = quality === "easy" ? 5 : 4;
  let newEf = Math.max(1.3, ease_factor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  let newInterval = reps === 0 ? 1 : reps === 1 ? 6 : interval * newEf;
  if (quality === "easy") newInterval *= 1.3;
  return { reps: reps + 1, interval: newInterval, ease_factor: newEf };
}
function applyRating(id, quality) {
  const st = getCardState(id);
  const result = nextInterval(st, quality);
  const dueOffset = quality === "again" ? 10 * 60 * 1000 : result.interval * DAY_MS;
  const reviewedAt = Date.now();
  progress[id] = {
    in_deck: true,
    reps: result.reps,
    interval: result.interval,
    ease_factor: result.ease_factor,
    due_at: reviewedAt + dueOffset,
    lapses: (st.lapses || 0) + (quality === "again" ? 1 : 0),
    first_seen_on: st.first_seen_on || todayStr(),
  };
  user.review_events.push({
    card_id: id,
    reviewed_at: reviewedAt,
    rating: quality,
    previous_interval: st.interval || 0,
    new_interval: result.interval,
  });
  if (user.review_events.length > 5000) user.review_events = user.review_events.slice(-5000);
  stats.total_reviews += 1;
  const t = todayStr();
  stats.history[t] = (stats.history[t] || 0) + 1;
  updateStreak();
  saveUser();
}
function updateStreak() {
  const t = todayStr();
  if (stats.last_study_day === t) return;
  const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  stats.streak = stats.last_study_day === yesterday ? stats.streak + 1 : 1;
  stats.last_study_day = t;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function isInDeck(card) {
  const state = progress[card.id];
  return state ? state.in_deck !== false : card.default_in_deck !== false;
}
function getDueCards() {
  const now = Date.now();
  return DATA.filter(c => {
    const state = progress[c.id];
    return isInDeck(c) && state && state.reps > 0 && state.due_at <= now;
  });
}
function getNewCards() {
  return DATA.filter(c => isInDeck(c) && getCardState(c.id).reps === 0);
}
function getTodayNewCount() {
  const t = todayStr();
  return Object.values(progress).filter(p => p.first_seen_on === t).length;
}
function buildSession() {
  const due = shuffle(getDueCards());
  const budget = Math.max(0, settings.new_per_day - getTodayNewCount());
  const newCards = shuffle(getNewCards()).slice(0, budget);
  const queue = [];
  let di = 0, ni = 0;
  while (di < due.length || ni < newCards.length) {
    for (let k = 0; k < 3 && di < due.length; k++) queue.push(due[di++]);
    if (ni < newCards.length) queue.push(newCards[ni++]);
  }
  return queue;
}

// ---------------------------------------------------------------------------
// Card audio (review)
// ---------------------------------------------------------------------------
let cardAudio = null;
let cardAudioStop = null;

function playCardAudio(card) {
  if (!card || !card.audio_path || card.audio_start == null) return;
  const src = card.audio_path;
  if (!cardAudio || cardAudio.dataset.src !== src) {
    if (cardAudio) cardAudio.pause();
    cardAudio = new Audio(src);
    cardAudio.dataset.src = src;
    cardAudio.addEventListener("timeupdate", () => {
      if (cardAudioStop != null && cardAudio.currentTime >= cardAudioStop) {
        cardAudio.pause();
        cardAudioStop = null;
      }
    });
  }
  cardAudioStop = card.audio_end + 0.3;
  cardAudio.currentTime = card.audio_start;
  cardAudio.play();
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const screens = {};
function show(id) {
  Object.values(screens).forEach(s => s && s.classList.add("hidden"));
  if (screens[id]) screens[id].classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function renderHome() {
  const due = getDueCards().length;
  const budget = Math.max(0, settings.new_per_day - getTodayNewCount());
  const newAvail = Math.min(getNewCards().length, budget);
  $("stat-due").textContent = due;
  $("stat-new").textContent = newAvail;
  $("stat-streak").textContent = stats.streak || 0;
  const learned = Object.values(progress).filter(p => p.reps >= 1).length;
  $("stat-learned").textContent = learned;
  const pct = DATA.length ? Math.round(learned / DATA.length * 100) : 0;
  $("progress-pct").textContent = pct + "%";
  $("progress-fill").style.width = pct + "%";
  $("btn-start").disabled = (due + newAvail) === 0;
  $("btn-start").textContent = (due + newAvail) === 0 ? "All caught up! 🎉" : "Start Review";
}

function cycleProgress(num) {
  const words = (CYCLE_DATA.words[String(num)] || []);
  if (!words.length) return { pct: 0, learned: 0, total: 0 };
  const learned = words.filter(w => getCardState(w.id).reps >= 1).length;
  return { pct: Math.round(learned / words.length * 100), learned, total: words.length };
}

function renderCurrentCycleCard() {
  const meta = CYCLES_META.find(c => c.num === currentCycleNum);
  if (!meta) return;
  const { pct } = cycleProgress(currentCycleNum);
  const el = $("current-cycle-card");
  el.innerHTML = `
    <div class="cch-num">Ciclo ${meta.num}</div>
    <div class="cch-body">
      <div class="cch-title">${escapeHtml(meta.title)}</div>
      <div class="cch-bar-wrap"><div class="cch-bar" style="width:${pct}%"></div></div>
    </div>
    <div class="cch-arrow">›</div>
  `;
  el.onclick = () => openCycleDetail(currentCycleNum);
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------
let currentQueue = [], currentIndex = 0, currentCard = null, sessionReviewed = 0;

function startSession() {
  currentQueue = buildSession();
  currentIndex = 0;
  sessionReviewed = 0;
  if (!currentQueue.length) { renderHome(); return; }
  show("screen-review");
  nextCard();
}

function nextCard() {
  if (currentIndex >= currentQueue.length) { finishSession(); return; }
  currentCard = currentQueue[currentIndex];
  renderCard(currentCard);
  updateReviewProgress();
}

function renderCard(card) {
  $("card").classList.remove("flipped");
  $("rating-row").classList.add("hidden");
  $("tap-hint").classList.remove("hidden");
  $("card-cat").textContent = card.cat;
  $("card-cat-back").textContent = card.cat;
  $("card-term").textContent = card.es;
  $("card-emoji").textContent = card.emoji || "";
  $("card-definition").textContent = card.def || card.en;
  $("card-example").textContent = card.x || "";
  const imgLink = $("card-image-link");
  imgLink.href = "https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(card.es);
  imgLink.classList.toggle("hidden", !!card.emoji);
  $("card-audio-btn").classList.toggle("hidden", card.audio_start == null);
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
  applyRating(id, quality);
  sessionReviewed++;
  if (quality === "again") currentQueue.splice(Math.min(currentQueue.length, currentIndex + 4), 0, currentCard);
  currentIndex++;
  nextCard();
}

function updateReviewProgress() {
  const total = currentQueue.length, done = currentIndex;
  $("review-progress-fill").style.width = (total ? done / total * 100 : 100) + "%";
  $("review-remaining").textContent = Math.max(0, total - done);
}

function finishSession() {
  $("done-summary").textContent = `You reviewed ${sessionReviewed} card${sessionReviewed === 1 ? "" : "s"}. ¡Buen trabajo!`;
  show("screen-done");
}

// ---------------------------------------------------------------------------
// Cycles list
// ---------------------------------------------------------------------------
function openCyclesList() {
  show("screen-cycles");
  const list = $("cycles-list");
  list.innerHTML = "";
  CYCLES_META.forEach(meta => {
    const { pct, learned, total } = cycleProgress(meta.num);
    const badge = pct === 100 ? `<span class="cycle-row-badge badge-done">Done</span>`
                : pct > 0    ? `<span class="cycle-row-badge badge-started">${pct}%</span>`
                :              `<span class="cycle-row-badge badge-new">New</span>`;
    const row = document.createElement("div");
    row.className = "cycle-row";
    row.innerHTML = `
      <div class="cycle-row-num">C${meta.num}</div>
      <div class="cycle-row-body">
        <div class="cycle-row-title">${escapeHtml(meta.title)}</div>
        <div class="cycle-row-meta">${total} words · ${fmtTime(meta.duration)}</div>
        <div class="cycle-row-bar-wrap"><div class="cycle-row-bar" style="width:${pct}%"></div></div>
      </div>
      ${badge}
    `;
    row.onclick = () => openCycleDetail(meta.num);
    list.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Cycle detail + Spanish-only audio player
// ---------------------------------------------------------------------------
let cycleAudio = null;
let cycleAudioRAF = null;
let currentDetailCycle = null;
let cycleSegs = [];       // Spanish segments for current cycle
let cycleSegIdx = 0;      // which segment we're on
let cycleSegPlayed = 0;   // cumulative seconds of Spanish played (for progress)
let cycleTotalSpanish = 0; // total seconds of Spanish content

function openCycleDetail(num) {
  currentDetailCycle = num;
  currentCycleNum = num;
  saveUser();

  const meta = CYCLES_META.find(c => c.num === num);
  cycleSegs = CYCLE_DATA.segments[String(num)] || [];
  cycleTotalSpanish = cycleSegs.reduce((sum, s) => sum + (s.e - s.s), 0);

  $("cycle-detail-title").textContent = meta ? meta.title : `Ciclo ${num}`;
  $("btn-reveal-text").textContent = "Revelar texto";
  const textWrap = $("cycle-text-wrap");
  textWrap.classList.add("hidden");
  textWrap.style.display = "none";
  $("cycle-progress-fill").style.width = "0%";
  $("cycle-time-current").textContent = "0:00";
  $("cycle-time-total").textContent = fmtTime(cycleTotalSpanish);
  $("cycle-play-btn").textContent = "▶";

  const textEl = $("cycle-text");
  textEl.innerHTML = cycleSegs.map((s, i) =>
    `<span class="seg-line" data-idx="${i}" data-start="${s.s}" data-end="${s.e}">${escapeHtml(s.t)}</span>`
  ).join("\n");

  const words = CYCLE_DATA.words[String(num)] || [];
  const vocabList = $("cycle-vocab-list");
  vocabList.innerHTML = "";
  $("cycle-vocab-count").textContent = `${words.length} words`;
  words.forEach(w => {
    const card = DATA.find(item => item.id === w.id);
    const inDeck = card ? isInDeck(card) : false;
    const row = document.createElement("div");
    row.className = "vocab-row";
    row.innerHTML = `
      <div class="vocab-word">${escapeHtml(w.es)}</div>
      <div class="vocab-cat">${escapeHtml(w.cat)}</div>
      <button class="vocab-badge ${inDeck ? "vb-in-deck" : "vb-add"}" data-id="${w.id}">
        ${inDeck ? "In deck" : "+ Add"}
      </button>
    `;
    row.querySelector("button").addEventListener("click", () => addWordToDeck(w, row));
    vocabList.appendChild(row);
  });

  stopCycleAudio();
  show("screen-cycle-detail");
}

function stopCycleAudio() {
  if (cycleAudio) { cycleAudio.pause(); cycleAudio = null; }
  if (cycleAudioRAF) { cancelAnimationFrame(cycleAudioRAF); cycleAudioRAF = null; }
  $("cycle-play-btn").textContent = "▶";
  cycleSegIdx = 0;
  cycleSegPlayed = 0;
}

function toggleCyclePlay() {
  if (!currentDetailCycle || !cycleSegs.length) return;

  if (cycleAudio && !cycleAudio.paused) {
    cycleAudio.pause();
    $("cycle-play-btn").textContent = "▶";
    if (cycleAudioRAF) { cancelAnimationFrame(cycleAudioRAF); cycleAudioRAF = null; }
    return;
  }

  if (!cycleAudio) {
    cycleAudio = new Audio(`audio/Cycle ${currentDetailCycle}.mp3`);
    cycleAudio.addEventListener("timeupdate", onCycleTimeUpdate);
    cycleAudio.addEventListener("ended", onCycleEnded);
    cycleSegIdx = 0;
    cycleSegPlayed = 0;
    // Seek to first Spanish segment only after metadata is ready
    cycleAudio.addEventListener("loadedmetadata", () => {
      cycleAudio.currentTime = cycleSegs[0].s;
    }, { once: true });
  }

  cycleAudio.play();
  $("cycle-play-btn").textContent = "⏸";
  tickCycleProgress();
}

function onCycleTimeUpdate() {
  if (!cycleAudio || !cycleSegs.length) return;
  const cur = cycleAudio.currentTime;
  const seg = cycleSegs[cycleSegIdx];
  if (!seg) return;

  // If we've gone past the end of this segment, jump to next
  if (cur >= seg.e + 0.1) {
    // Accumulate played time for this segment
    cycleSegPlayed += (seg.e - seg.s);
    cycleSegIdx++;
    if (cycleSegIdx >= cycleSegs.length) {
      cycleAudio.pause();
      onCycleEnded();
      return;
    }
    cycleAudio.currentTime = cycleSegs[cycleSegIdx].s;
  }
}

function onCycleEnded() {
  $("cycle-play-btn").textContent = "▶";
  if (cycleAudioRAF) { cancelAnimationFrame(cycleAudioRAF); cycleAudioRAF = null; }
  $("cycle-progress-fill").style.width = "100%";
  $("cycle-time-current").textContent = fmtTime(cycleTotalSpanish);
}

function tickCycleProgress() {
  if (!cycleAudio || cycleAudio.paused) return;
  const cur = cycleAudio.currentTime;
  const seg = cycleSegs[cycleSegIdx];

  if (seg && cycleTotalSpanish > 0) {
    const playedInSeg = Math.max(0, cur - seg.s);
    const totalPlayed = cycleSegPlayed + playedInSeg;
    $("cycle-progress-fill").style.width = (totalPlayed / cycleTotalSpanish * 100) + "%";
    $("cycle-time-current").textContent = fmtTime(totalPlayed);
  }

  highlightActiveSeg(cur);
  cycleAudioRAF = requestAnimationFrame(tickCycleProgress);
}

function highlightActiveSeg(currentTime) {
  const lines = document.querySelectorAll(".seg-line");
  lines.forEach(line => {
    const start = parseFloat(line.dataset.start);
    const end = parseFloat(line.dataset.end);
    line.classList.toggle("active", currentTime >= start && currentTime < end);
  });
}

function seekCycleAudio(e) {
  if (!cycleAudio || !cycleSegs.length || !cycleTotalSpanish) return;
  const pct = e.offsetX / e.currentTarget.offsetWidth;
  const targetPlayed = pct * cycleTotalSpanish;

  // Find which segment this falls in
  let acc = 0;
  for (let i = 0; i < cycleSegs.length; i++) {
    const segDur = cycleSegs[i].e - cycleSegs[i].s;
    if (acc + segDur >= targetPlayed) {
      cycleSegIdx = i;
      cycleSegPlayed = acc;
      cycleAudio.currentTime = cycleSegs[i].s + (targetPlayed - acc);
      return;
    }
    acc += segDur;
  }
}

function addWordToDeck(word, row) {
  const existing = getCardState(word.id);
  if (existing.in_deck && progress[word.id]) return;
  progress[word.id] = Object.assign({}, existing, { in_deck: true });
  saveUser();
  const btn = row.querySelector("button");
  btn.textContent = "In deck";
  btn.className = "vocab-badge vb-in-deck";
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------
let activeCategory = "all";

function cardStatus(card) {
  const p = getCardState(card.id);
  if (!isInDeck(card)) return { cls: "bs-new", label: "Not in deck" };
  if (!p.reps) return { cls: "bs-new", label: "New" };
  if (p.reps >= 1 && p.interval >= 21) return { cls: "bs-mastered", label: "Mastered" };
  return { cls: "bs-learning", label: "Learning" };
}

function renderCategoryChips() {
  const cats = Array.from(new Set(DATA.map(c => c.cat)));
  const wrap = $("category-chips");
  wrap.innerHTML = "";
  [["all", "All"], ...cats.map(c => [c, c])].forEach(([val, label]) => {
    const chip = document.createElement("div");
    chip.className = "chip" + (activeCategory === val ? " active" : "");
    chip.textContent = label;
    chip.onclick = () => { activeCategory = val; renderCategoryChips(); renderBrowseList(); };
    wrap.appendChild(chip);
  });
}

function renderBrowseList() {
  const q = $("browse-search").value.trim().toLowerCase();
  const list = $("browse-list");
  list.innerHTML = "";
  DATA.filter(c => {
    if (activeCategory !== "all" && c.cat !== activeCategory) return false;
    if (q && !c.es.toLowerCase().includes(q) && !c.en.toLowerCase().includes(q)) return false;
    return true;
  }).slice(0, 300).forEach(c => {
    const status = cardStatus(c);
    const item = document.createElement("div");
    item.className = "browse-item";
    item.innerHTML = `
      <div><div class="b-es">${escapeHtml(c.es)}</div><div class="b-en">${escapeHtml(c.en)}</div></div>
      <div class="browse-status ${status.cls}">${status.label}</div>
    `;
    list.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function renderSettings() { $("setting-new-per-day").value = settings.new_per_day; }
function saveSettings() {
  settings.new_per_day = parseInt($("setting-new-per-day").value, 10) || defaultSettings.new_per_day;
  saveUser();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function migrateV1UserState() {
  if (existingUser) return;
  const legacyProgress = loadJSON(LS_PROGRESS_V1, {});
  const legacySettings = loadJSON(LS_SETTINGS_V1, {});
  const legacyStats = loadJSON(LS_STATS_V1, {});
  const legacyCycle = loadJSON(LS_CYCLE_V1, 3);
  const cardByLegacyId = new Map(
    CONTENT.entities.cards.map(card => [String(card.source.legacy_id), card.id])
  );

  Object.entries(legacyProgress).forEach(([legacyId, state]) => {
    const id = cardByLegacyId.get(String(legacyId));
    if (!id) return;
    progress[id] = {
      in_deck: true,
      reps: state.reps || 0,
      interval: state.interval || 0,
      ease_factor: state.ef || 2.5,
      due_at: state.due || 0,
      lapses: state.lapses || 0,
      first_seen_on: state.firstSeen || null,
    };
  });
  settings.new_per_day = legacySettings.newPerDay || defaultSettings.new_per_day;
  stats = {
    streak: legacyStats.streak || 0,
    last_study_day: legacyStats.lastStudyDay || null,
    total_reviews: legacyStats.totalReviews || 0,
    history: legacyStats.history || {},
  };
  currentCycleNum = Number(legacyCycle) || 3;
  user.migrated_from = "v1";
  saveUser();
}

function buildRuntimeViews(bundle) {
  CONTENT = bundle;
  const entities = bundle.entities;
  const lexemeById = new Map(entities.lexemes.map(row => [row.id, row]));
  const occurrenceById = new Map(entities.occurrences.map(row => [row.id, row]));
  const lessonById = new Map(entities.lessons.map(row => [row.id, row]));
  const cardByLexeme = new Map();
  entities.cards.forEach(card => {
    if (!cardByLexeme.has(card.lexeme_id)) cardByLexeme.set(card.lexeme_id, card);
  });

  DATA = entities.cards.map(card => {
    const lexeme = lexemeById.get(card.lexeme_id);
    const occurrence = occurrenceById.get(card.example_occurrence_ids[0]);
    const lesson = occurrence && occurrence.lesson_id
      ? lessonById.get(occurrence.lesson_id)
      : null;
    return {
      id: card.id,
      lexeme_id: lexeme.id,
      es: card.prompt,
      en: card.answer,
      pos: lexeme.part_of_speech,
      cat: lexeme.categories[0] || "uncategorized",
      def: lexeme.definition_es,
      x: occurrence ? occurrence.text_es : "",
      y: occurrence ? occurrence.text_en : "",
      default_in_deck: card.default_in_deck,
      audio_path: lesson ? lesson.audio_asset.path : null,
      audio_start: occurrence && occurrence.audio_clip ? occurrence.audio_clip.start_seconds : null,
      audio_end: occurrence && occurrence.audio_clip ? occurrence.audio_clip.end_seconds : null,
    };
  });

  CYCLES_META = entities.lessons
    .slice()
    .sort((a, b) => a.number - b.number)
    .map(lesson => ({
      id: lesson.id,
      num: lesson.number,
      title: lesson.title,
      duration: lesson.duration_seconds,
      spanish_count: entities.segments.filter(segment => segment.lesson_id === lesson.id).length,
    }));

  CYCLE_DATA = { segments: {}, words: {} };
  CYCLES_META.forEach(meta => {
    const lessonId = `lesson:fsi:${String(meta.num).padStart(2, "0")}`;
    CYCLE_DATA.segments[String(meta.num)] = entities.segments
      .filter(segment => segment.lesson_id === lessonId)
      .sort((a, b) => a.sequence - b.sequence)
      .map(segment => ({
        id: segment.id,
        s: segment.start_seconds,
        e: segment.end_seconds,
        t: segment.text,
        manual_reference: segment.manual_reference,
      }));
    CYCLE_DATA.words[String(meta.num)] = entities.lesson_vocabulary
      .filter(link => link.lesson_id === lessonId)
      .map(link => {
        const lexeme = lexemeById.get(link.lexeme_id);
        const card = cardByLexeme.get(link.lexeme_id);
        return {
          id: card.id,
          lexeme_id: lexeme.id,
          es: lexeme.lemma,
          cat: lexeme.categories[0] || "uncategorized",
        };
      });
  });
}

async function init() {
  screens["screen-home"]         = $("screen-home");
  screens["screen-review"]       = $("screen-review");
  screens["screen-done"]         = $("screen-done");
  screens["screen-cycles"]       = $("screen-cycles");
  screens["screen-cycle-detail"] = $("screen-cycle-detail");
  screens["screen-browse"]       = $("screen-browse");
  screens["screen-settings"]     = $("screen-settings");

  const contentRes = await fetch("app_data_v2.json");
  buildRuntimeViews(await contentRes.json());
  migrateV1UserState();

  renderHome();

  // Home
  $("btn-start").addEventListener("click", startSession);
  $("btn-all-cycles").addEventListener("click", openCyclesList);
  $("btn-browse").addEventListener("click", () => { show("screen-browse"); renderCategoryChips(); renderBrowseList(); });
  $("btn-settings").addEventListener("click", () => { renderSettings(); show("screen-settings"); });

  // Review
  $("btn-exit-review").addEventListener("click", () => { show("screen-home"); renderHome(); });
  $("card").addEventListener("click", () => { if (!$("card").classList.contains("flipped")) flipCard(); });
  document.querySelectorAll(".rate-btn").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); rate(btn.dataset.q); });
  });
  $("card-audio-btn").addEventListener("click", e => { e.stopPropagation(); playCardAudio(currentCard); });

  // Done
  $("btn-done-home").addEventListener("click", () => { show("screen-home"); renderHome(); });

  // Cycles
  $("btn-cycles-back").addEventListener("click", () => { show("screen-home"); renderHome(); });
  $("btn-cycle-back").addEventListener("click", () => openCyclesList());
  $("cycle-play-btn").addEventListener("click", toggleCyclePlay);
  $("cycle-progress-bar").addEventListener("click", seekCycleAudio);
  $("btn-reveal-text").addEventListener("click", () => {
    const wrap = $("cycle-text-wrap");
    const nowHidden = wrap.classList.toggle("hidden");
    wrap.style.display = nowHidden ? "none" : "block";
    $("btn-reveal-text").textContent = nowHidden ? "Revelar texto" : "Ocultar texto";
  });

  // Browse
  $("btn-browse-back").addEventListener("click", () => { show("screen-home"); renderHome(); });
  $("browse-search").addEventListener("input", renderBrowseList);

  // Settings
  $("btn-settings-back").addEventListener("click", () => { saveSettings(); show("screen-home"); renderHome(); });
  $("setting-new-per-day").addEventListener("change", saveSettings);
  $("btn-reset-progress").addEventListener("click", () => {
    if (confirm("Reset all progress? This cannot be undone.")) {
      progress = {};
      stats = { streak: 0, last_study_day: null, total_reviews: 0, history: {} };
      user.cards = progress;
      user.review_events = [];
      user.lesson_progress = {};
      saveUser();
      show("screen-home");
      renderHome();
    }
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
