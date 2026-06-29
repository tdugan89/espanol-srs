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
function cleanFsiExample(text) {
  if (!text) return "";
  const cleaned = text.replace(/^[Nn]úmero\s+\w+[.,]?\s*/u, "").trim();
  // Chained comprehension prompts contain a second "Número N" in the remainder
  if (/[Nn]úmero\s+\w/u.test(cleaned)) return "";
  return cleaned;
}
function fmtTime(secs) {
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return m + ":" + String(s).padStart(2, "0");
}

let DATA = [];
let CYCLES_META = [];
let CYCLE_DATA = { segments: {}, words: {} };
let CONTENT = null;
let LEXEME_BY_ID = new Map();
let OCCURRENCE_BY_ID = new Map();
let LESSON_BY_ID = new Map();
let SEGMENT_BY_ID = new Map();
let VISUAL_BY_LEXEME = new Map();
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
if (!Array.isArray(user.review_events)) user.review_events = [];
if (!Array.isArray(user.hint_events)) user.hint_events = [];
if (!Array.isArray(user.audio_events)) user.audio_events = [];
if (!Array.isArray(user.quiz_events)) user.quiz_events = [];

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
function applyRating(id, quality, eventDetails = {}) {
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
    english_hint_used: currentCardUsedEnglish,
    response_ms: currentCardShownAt ? reviewedAt - currentCardShownAt : null,
    audio_plays: currentCardAudioPlays,
    mode: eventDetails.mode || "flashcard",
    ...eventDetails,
  });
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
function inCategory(card, category) {
  return category === "all" || card.cat === category;
}
function getDueCards(category = "all") {
  const now = Date.now();
  return DATA.filter(c => {
    const state = progress[c.id];
    return inCategory(c, category) && isInDeck(c) && state && state.reps > 0 && state.due_at <= now;
  });
}
function getNewCards(category = "all") {
  return DATA.filter(c => inCategory(c, category) && isInDeck(c) && getCardState(c.id).reps === 0);
}
function getTodayNewCount() {
  const t = todayStr();
  return Object.values(progress).filter(p => p.first_seen_on === t).length;
}
function buildSession(category = "all") {
  const due = shuffle(getDueCards(category));
  const budget = Math.max(0, settings.new_per_day - getTodayNewCount());
  const newCards = shuffle(getNewCards(category)).slice(0, budget);
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
let cardAudioLoadToken = 0;

function prepareCardAudio(card) {
  if (!card || !card.audio_path || card.audio_start == null) return null;
  const src = card.audio_path;
  if (!cardAudio || cardAudio.dataset.src !== src) {
    if (cardAudio) cardAudio.pause();
    cardAudio = new Audio(src);
    cardAudio.preload = "auto";
    cardAudio.dataset.src = src;
    cardAudio.addEventListener("timeupdate", () => {
      if (cardAudioStop != null && cardAudio.currentTime >= cardAudioStop) {
        cardAudio.pause();
        cardAudioStop = null;
      }
    });
    cardAudio.load();
  }
  return cardAudio;
}

function playCardAudio(card) {
  const audio = prepareCardAudio(card);
  if (!audio) return;
  const token = ++cardAudioLoadToken;
  cardAudioStop = card.audio_end + 0.3;
  const seekAndPlay = () => {
    if (token !== cardAudioLoadToken || audio !== cardAudio) return;
    const upperBound = Number.isFinite(audio.duration)
      ? Math.max(0, audio.duration - 0.05)
      : card.audio_start;
    audio.currentTime = Math.min(card.audio_start, upperBound);
    audio.play().then(() => {
      if (card === currentCard) currentCardAudioPlays += 1;
      user.audio_events = Array.isArray(user.audio_events) ? user.audio_events : [];
      user.audio_events.push({
        card_id: card.id,
        played_at: Date.now(),
        lesson_id: card.lesson_id || null,
      });
      saveUser();
    }).catch(() => {});
  };
  if (audio.readyState >= 1) {
    seekAndPlay();
  } else {
    audio.addEventListener("loadedmetadata", seekAndPlay, { once: true });
  }
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
let reviewCategory = "all";

function commonCategories() {
  const counts = new Map();
  DATA.forEach(card => counts.set(card.cat, (counts.get(card.cat) || 0) + 1));
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category]) => category);
}

function renderHomeCategoryChips() {
  const categories = ["all", ...commonCategories()];
  const wrap = $("home-category-chips");
  wrap.innerHTML = "";
  categories.forEach(category => {
    const button = document.createElement("button");
    button.className = "home-category-chip" + (category === reviewCategory ? " active" : "");
    button.dataset.category = category;
    button.textContent = category === "all" ? "All words" : category;
    button.addEventListener("click", () => {
      reviewCategory = category;
      renderHome();
    });
    wrap.appendChild(button);
  });
  $("home-filter-label").textContent = reviewCategory === "all" ? "All words" : reviewCategory;
}

function renderHome() {
  const due = getDueCards(reviewCategory).length;
  const budget = Math.max(0, settings.new_per_day - getTodayNewCount());
  const newAvail = Math.min(getNewCards(reviewCategory).length, budget);
  $("stat-due").textContent = due;
  $("stat-new").textContent = newAvail;
  $("stat-streak").textContent = stats.streak || 0;
  const learned = Object.values(progress).filter(p => p.reps >= 1).length;
  $("stat-learned").textContent = learned;
  const pct = DATA.length ? Math.round(learned / DATA.length * 100) : 0;
  $("progress-pct").textContent = pct + "%";
  $("progress-fill").style.width = pct + "%";
  $("btn-start").disabled = (due + newAvail) === 0;
  const scope = reviewCategory === "all" ? "" : `: ${reviewCategory}`;
  $("btn-start").textContent = (due + newAvail) === 0 ? "All caught up! 🎉" : `Start review${scope}`;
  const studyBtn = $("btn-study-category");
  if (reviewCategory !== "all") {
    const total = DATA.filter(c => inCategory(c, reviewCategory)).length;
    studyBtn.textContent = `Study all ${total} ${reviewCategory} words`;
    studyBtn.classList.remove("hidden");
  } else {
    studyBtn.classList.add("hidden");
  }
  const learnedQuizCount = getClozeCandidates(true).length;
  $("btn-quiz").textContent = learnedQuizCount
    ? `Practice recall · ${Math.min(5, learnedQuizCount)} blank${learnedQuizCount === 1 ? "" : "s"}`
    : "Try sentence recall · 5 blanks";
  renderHomeCategoryChips();
  renderCurrentCycleCard();
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
let currentCardUsedEnglish = false;
let currentCardShownAt = null;
let currentCardAudioPlays = 0;

function startSession() {
  currentQueue = buildSession(reviewCategory);
  currentIndex = 0;
  sessionReviewed = 0;
  if (!currentQueue.length) { renderHome(); return; }
  show("screen-review");
  nextCard();
}

function startCategoryDrill() {
  const all = DATA.filter(c => inCategory(c, reviewCategory));
  const unlearned = shuffle(all.filter(c => getCardState(c.id).reps === 0));
  const learned = shuffle(all.filter(c => getCardState(c.id).reps > 0));
  currentQueue = unlearned.concat(learned);
  currentIndex = 0;
  sessionReviewed = 0;
  if (!currentQueue.length) return;
  show("screen-review");
  nextCard();
}

function startFocusedSession(card) {
  currentQueue = [card];
  currentIndex = 0;
  sessionReviewed = 0;
  currentCard = null;
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
  currentCardUsedEnglish = false;
  currentCardShownAt = Date.now();
  currentCardAudioPlays = 0;
  $("card").classList.remove("flipped");
  $("rating-row").classList.add("hidden");
  $("tap-hint").classList.remove("hidden");
  $("card-cat").textContent = card.cat;
  $("card-cat-back").textContent = card.cat;
  const hasVisual = Boolean(card.visual_cue);
  $("card-term").textContent = hasVisual ? "" : card.es;
  renderVisualCue($("card-front-visual"), card.visual_cue);
  renderVisualCue($("card-back-visual"), hasVisual ? card.visual_cue : null);
  $("card-definition").textContent = hasVisual ? card.es : (card.x || card.def || card.es);
  $("card-example").textContent = hasVisual ? (card.x || "") : "";
  $("card-example").classList.toggle("hidden", !hasVisual || !card.x);
  $("card-english").textContent = card.en;
  $("card-english").classList.add("hidden");
  $("card-english-btn").textContent = "Show English";
  $("card-audio-btn").classList.toggle("hidden", card.audio_start == null);
  prepareCardAudio(card);
  const iv = previewIntervals(card.id);
  $("iv-again").textContent = iv.again;
  $("iv-hard").textContent = iv.hard;
  $("iv-good").textContent = iv.good;
  $("iv-easy").textContent = iv.easy;
}

function renderVisualCue(element, cue) {
  element.innerHTML = "";
  element.classList.remove("emoji", "image");
  element.classList.toggle("hidden", !cue);
  if (!cue) return;
  element.classList.add(cue.kind);
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", cue.alt_es);
  if (cue.kind === "emoji") {
    element.textContent = cue.value;
  } else if (cue.kind === "image") {
    const image = document.createElement("img");
    image.src = cue.asset_path;
    image.alt = cue.alt_es;
    image.loading = "lazy";
    element.appendChild(image);
  }
}

function revealEnglish(card, context) {
  if (!card) return;
  user.hint_events.push({
    card_id: card.id,
    used_at: Date.now(),
    kind: "english",
    context,
  });
  if (card === currentCard) currentCardUsedEnglish = true;
  saveUser();
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
// Spanish sentence cloze quiz
// ---------------------------------------------------------------------------
let quizQueue = [];
let quizIndex = 0;
let quizCard = null;
let quizHintLevel = 0;
let quizAnswered = false;
let quizStartedAt = null;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clozePattern(term) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(term)})(?=$|[^\\p{L}\\p{N}])`, "iu");
}

function makeCloze(card) {
  if (!card || !card.x || !card.es) return null;
  const pattern = clozePattern(card.es);
  if (!pattern.test(card.x)) return null;
  return card.x.replace(pattern, (_, prefix) => `${prefix}_____`);
}

function getClozeCandidates(learnedOnly = false) {
  return DATA.filter(card => {
    if (!isInDeck(card) || !makeCloze(card)) return false;
    return !learnedOnly || getCardState(card.id).reps > 0;
  });
}

function normalizeAnswer(value, keepAccents = false) {
  let normalized = String(value || "").trim().toLocaleLowerCase("es");
  normalized = normalized.replace(/[¿?¡!.,;:()[\]{}"“”'’]/g, "").replace(/\s+/g, " ");
  if (!keepAccents) normalized = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return normalized;
}

function startQuiz() {
  const learned = shuffle(getClozeCandidates(true));
  const learnedIds = new Set(learned.map(card => card.id));
  const practice = shuffle(getClozeCandidates(false).filter(card => !learnedIds.has(card.id)));
  quizQueue = learned.concat(practice).slice(0, 5);
  if (!quizQueue.length) return;
  quizIndex = 0;
  show("screen-quiz");
  renderQuizQuestion();
}

function renderQuizQuestion() {
  if (quizIndex >= quizQueue.length) {
    $("done-summary").textContent = `Completaste ${quizQueue.length} frase${quizQueue.length === 1 ? "" : "s"}. Los resultados ya están en tu repaso.`;
    show("screen-done");
    return;
  }
  quizCard = quizQueue[quizIndex];
  quizHintLevel = 0;
  quizAnswered = false;
  quizStartedAt = Date.now();
  currentCard = quizCard;
  currentCardShownAt = quizStartedAt;
  currentCardUsedEnglish = false;
  currentCardAudioPlays = 0;
  $("quiz-sentence").textContent = makeCloze(quizCard);
  renderVisualCue($("quiz-visual"), quizCard.visual_cue);
  $("quiz-answer").value = "";
  $("quiz-answer").disabled = false;
  $("quiz-feedback").textContent = "";
  $("quiz-feedback").className = "quiz-feedback";
  $("quiz-exact-answer").textContent = "";
  $("quiz-exact-answer").classList.add("hidden");
  $("quiz-hint-text").textContent = "";
  $("btn-quiz-hint").classList.remove("hidden");
  $("btn-quiz-check").classList.remove("hidden");
  $("btn-quiz-next").classList.add("hidden");
  $("btn-quiz-audio").classList.toggle("hidden", quizCard.audio_start == null);
  $("quiz-position").textContent = quizIndex + 1;
  $("quiz-progress-fill").style.width = `${quizIndex / quizQueue.length * 100}%`;
  prepareCardAudio(quizCard);
  $("quiz-answer").focus();
}

function showQuizHint() {
  if (!quizCard || quizAnswered) return;
  quizHintLevel += 1;
  const answer = quizCard.es;
  if (quizHintLevel === 1) {
    $("quiz-hint-text").textContent = `Empieza con “${answer.charAt(0)}”`;
  } else if (quizHintLevel === 2) {
    const letters = Array.from(answer).map(char => /\p{L}/u.test(char) ? "•" : char).join(" ");
    $("quiz-hint-text").textContent = letters;
  } else if (quizHintLevel === 3 && quizCard.audio_start != null) {
    $("quiz-hint-text").textContent = "Escucha la frase completa.";
    playCardAudio(quizCard);
  } else {
    $("quiz-hint-text").textContent = answer;
    $("btn-quiz-hint").classList.add("hidden");
  }
}

function checkQuizAnswer() {
  if (!quizCard || quizAnswered) return;
  const typed = $("quiz-answer").value;
  if (!typed.trim()) {
    $("quiz-feedback").textContent = "Escribe una respuesta o pide una pista.";
    return;
  }
  const exact = normalizeAnswer(typed, true) === normalizeAnswer(quizCard.es, true);
  const accentMatch = normalizeAnswer(typed) === normalizeAnswer(quizCard.es);
  const correct = exact || accentMatch;
  const rating = correct ? (quizHintLevel ? "hard" : "good") : "again";
  const answeredAt = Date.now();
  user.quiz_events.push({
    card_id: quizCard.id,
    answered_at: answeredAt,
    answer: typed,
    expected: quizCard.es,
    correct,
    accent_exact: exact,
    hints_used: quizHintLevel,
    response_ms: answeredAt - quizStartedAt,
  });
  applyRating(quizCard.id, rating, {
    mode: "cloze",
    typed_answer: typed,
    correct,
    accent_exact: exact,
    hints_used: quizHintLevel,
  });
  quizAnswered = true;
  $("quiz-answer").disabled = true;
  $("quiz-feedback").className = `quiz-feedback ${correct ? "correct" : "incorrect"}`;
  $("quiz-feedback").textContent = correct
    ? (exact ? "¡Correcto!" : "Correcto — revisa el acento.")
    : "Todavía no.";
  $("quiz-exact-answer").textContent = quizCard.es;
  $("quiz-exact-answer").classList.remove("hidden");
  $("btn-quiz-hint").classList.add("hidden");
  $("btn-quiz-check").classList.add("hidden");
  $("btn-quiz-next").classList.remove("hidden");
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
let cycleSingleSegmentMode = false;

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
    `<span class="seg-line" role="button" tabindex="0" data-idx="${i}" data-start="${s.s}" data-end="${s.e}" aria-label="Play: ${escapeHtml(s.t)}">${escapeHtml(s.t)}</span>`
  ).join("\n");
  textEl.querySelectorAll(".seg-line").forEach(line => {
    const play = () => playCycleSegment(Number(line.dataset.idx));
    line.addEventListener("click", play);
    line.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        play();
      }
    });
  });

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
    row.addEventListener("click", () => {
      if (card) openWordDetail(card, "screen-cycle-detail");
    });
    row.querySelector("button").addEventListener("click", event => {
      event.stopPropagation();
      addWordToDeck(w, row);
    });
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
  cycleSingleSegmentMode = false;
}

function toggleCyclePlay() {
  if (!currentDetailCycle || !cycleSegs.length) return;

  if (cycleAudio && !cycleAudio.paused) {
    cycleAudio.pause();
    $("cycle-play-btn").textContent = "▶";
    if (cycleAudioRAF) { cancelAnimationFrame(cycleAudioRAF); cycleAudioRAF = null; }
    return;
  }

  cycleSingleSegmentMode = false;
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

function ensureCycleAudio() {
  if (cycleAudio) return;
  cycleAudio = new Audio(`audio/Cycle ${currentDetailCycle}.mp3`);
  cycleAudio.addEventListener("timeupdate", onCycleTimeUpdate);
  cycleAudio.addEventListener("ended", onCycleEnded);
}

function playCycleSegment(index) {
  if (!cycleSegs[index]) return;
  ensureCycleAudio();
  cycleSegIdx = index;
  cycleSingleSegmentMode = true;
  cycleSegPlayed = cycleSegs
    .slice(0, index)
    .reduce((sum, segment) => sum + (segment.e - segment.s), 0);
  cycleAudio.currentTime = cycleSegs[index].s;
  cycleAudio.play();
  $("cycle-play-btn").textContent = "⏸";
  highlightActiveSeg(cycleAudio.currentTime);
  tickCycleProgress();
}

function onCycleTimeUpdate() {
  if (!cycleAudio || !cycleSegs.length) return;
  const cur = cycleAudio.currentTime;
  const seg = cycleSegs[cycleSegIdx];
  if (!seg) return;

  // If we've gone past the end of this segment, jump to next
  if (cur >= seg.e + 0.1) {
    if (cycleSingleSegmentMode) {
      cycleAudio.pause();
      cycleSingleSegmentMode = false;
      $("cycle-play-btn").textContent = "▶";
      highlightActiveSeg(-1);
      return;
    }
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
    const item = document.createElement("button");
    item.type = "button";
    item.className = "browse-item";
    item.setAttribute("aria-label", `Open ${c.es}`);
    item.innerHTML = `
      <div><div class="b-es">${escapeHtml(c.es)}</div><div class="b-en">${escapeHtml(c.en)}</div></div>
      <div class="browse-status ${status.cls}">${status.label}</div>
    `;
    item.addEventListener("click", () => openWordDetail(c, "screen-browse"));
    list.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Conjugation tables
// ---------------------------------------------------------------------------
// Forms order: [yo, tú, él/ella, nosotros, vosotros, ellos]
const CONJ_IRREG = {
  "ser":      { pres:["soy","eres","es","somos","sois","son"],                         pret:["fui","fuiste","fue","fuimos","fuisteis","fueron"] },
  "estar":    { pres:["estoy","estás","está","estamos","estáis","están"],               pret:["estuve","estuviste","estuvo","estuvimos","estuvisteis","estuvieron"] },
  "tener":    { pres:["tengo","tienes","tiene","tenemos","tenéis","tienen"],             pret:["tuve","tuviste","tuvo","tuvimos","tuvisteis","tuvieron"] },
  "ir":       { pres:["voy","vas","va","vamos","vais","van"],                           pret:["fui","fuiste","fue","fuimos","fuisteis","fueron"] },
  "hacer":    { pres:["hago","haces","hace","hacemos","hacéis","hacen"],                pret:["hice","hiciste","hizo","hicimos","hicisteis","hicieron"] },
  "poder":    { pres:["puedo","puedes","puede","podemos","podéis","pueden"],             pret:["pude","pudiste","pudo","pudimos","pudisteis","pudieron"] },
  "querer":   { pres:["quiero","quieres","quiere","queremos","queréis","quieren"],       pret:["quise","quisiste","quiso","quisimos","quisisteis","quisieron"] },
  "decir":    { pres:["digo","dices","dice","decimos","decís","dicen"],                 pret:["dije","dijiste","dijo","dijimos","dijisteis","dijeron"] },
  "saber":    { pres:["sé","sabes","sabe","sabemos","sabéis","saben"],                  pret:["supe","supiste","supo","supimos","supisteis","supieron"] },
  "venir":    { pres:["vengo","vienes","viene","venimos","venís","vienen"],             pret:["vine","viniste","vino","vinimos","vinisteis","vinieron"] },
  "ver":      { pres:["veo","ves","ve","vemos","veis","ven"],                           pret:["vi","viste","vio","vimos","visteis","vieron"] },
  "dar":      { pres:["doy","das","da","damos","dais","dan"],                           pret:["di","diste","dio","dimos","disteis","dieron"] },
  "poner":    { pres:["pongo","pones","pone","ponemos","ponéis","ponen"],               pret:["puse","pusiste","puso","pusimos","pusisteis","pusieron"] },
  "traer":    { pres:["traigo","traes","trae","traemos","traéis","traen"],              pret:["traje","trajiste","trajo","trajimos","trajisteis","trajeron"] },
  "salir":    { pres:["salgo","sales","sale","salimos","salís","salen"],                pret:["salí","saliste","salió","salimos","salisteis","salieron"] },
  "conocer":  { pres:["conozco","conoces","conoce","conocemos","conocéis","conocen"],   pret:["conocí","conociste","conoció","conocimos","conocisteis","conocieron"] },
  "oír":      { pres:["oigo","oyes","oye","oímos","oís","oyen"],                       pret:["oí","oíste","oyó","oímos","oísteis","oyeron"] },
  "haber":    { pres:["he","has","ha","hemos","habéis","han"],                          pret:["hube","hubiste","hubo","hubimos","hubisteis","hubieron"] },
  "pedir":    { pres:["pido","pides","pide","pedimos","pedís","piden"],                 pret:["pedí","pediste","pidió","pedimos","pedisteis","pidieron"] },
  "dormir":   { pres:["duermo","duermes","duerme","dormimos","dormís","duermen"],       pret:["dormí","dormiste","durmió","dormimos","dormisteis","durmieron"] },
  "volver":   { pres:["vuelvo","vuelves","vuelve","volvemos","volvéis","vuelven"],      pret:["volví","volviste","volvió","volvimos","volvisteis","volvieron"] },
  "encontrar":{ pres:["encuentro","encuentras","encuentra","encontramos","encontráis","encuentran"], pret:["encontré","encontraste","encontró","encontramos","encontrasteis","encontraron"] },
  "entender": { pres:["entiendo","entiendes","entiende","entendemos","entendéis","entienden"], pret:["entendí","entendiste","entendió","entendimos","entendisteis","entendieron"] },
  "perder":   { pres:["pierdo","pierdes","pierde","perdemos","perdéis","pierden"],      pret:["perdí","perdiste","perdió","perdimos","perdisteis","perdieron"] },
  "recordar": { pres:["recuerdo","recuerdas","recuerda","recordamos","recordáis","recuerdan"], pret:["recordé","recordaste","recordó","recordamos","recordasteis","recordaron"] },
  "costar":   { pres:["cuesto","cuestas","cuesta","costamos","costáis","cuestan"],      pret:["costé","costaste","costó","costamos","costasteis","costaron"] },
  "pensar":   { pres:["pienso","piensas","piensa","pensamos","pensáis","piensan"],      pret:["pensé","pensaste","pensó","pensamos","pensasteis","pensaron"] },
  "preferir": { pres:["prefiero","prefieres","prefiere","preferimos","preferís","prefieren"], pret:["preferí","preferiste","prefirió","preferimos","preferisteis","prefirieron"] },
  "sentir":   { pres:["siento","sientes","siente","sentimos","sentís","sienten"],       pret:["sentí","sentiste","sintió","sentimos","sentisteis","sintieron"] },
  "seguir":   { pres:["sigo","sigues","sigue","seguimos","seguís","siguen"],            pret:["seguí","seguiste","siguió","seguimos","seguisteis","siguieron"] },
  "servir":   { pres:["sirvo","sirves","sirve","servimos","servís","sirven"],           pret:["serví","serviste","sirvió","servimos","servisteis","sirvieron"] },
  "empezar":  { pres:["empiezo","empiezas","empieza","empezamos","empezáis","empiezan"], pret:["empecé","empezaste","empezó","empezamos","empezasteis","empezaron"] },
  "jugar":    { pres:["juego","juegas","juega","jugamos","jugáis","juegan"],            pret:["jugué","jugaste","jugó","jugamos","jugasteis","jugaron"] },
  "leer":     { pres:["leo","lees","lee","leemos","leéis","leen"],                      pret:["leí","leíste","leyó","leímos","leísteis","leyeron"] },
  "caer":     { pres:["caigo","caes","cae","caemos","caéis","caen"],                   pret:["caí","caíste","cayó","caímos","caísteis","cayeron"] },
  "llegar":   { pres:["llego","llegas","llega","llegamos","llegáis","llegan"],          pret:["llegué","llegaste","llegó","llegamos","llegasteis","llegaron"] },
  "pagar":    { pres:["pago","pagas","paga","pagamos","pagáis","pagan"],               pret:["pagué","pagaste","pagó","pagamos","pagasteis","pagaron"] },
  "buscar":   { pres:["busco","buscas","busca","buscamos","buscáis","buscan"],          pret:["busqué","buscaste","buscó","buscamos","buscasteis","buscaron"] },
  "tocar":    { pres:["toco","tocas","toca","tocamos","tocáis","tocan"],               pret:["toqué","tocaste","tocó","tocamos","tocasteis","tocaron"] },
};

const CONJ_PRONOUNS = ["yo","tú","él/ella","nosotros","vosotros","ellos"];

function getConjugation(verb) {
  if (CONJ_IRREG[verb]) return CONJ_IRREG[verb];
  const m = verb.match(/^(.+?)(ar|er|ir)$/);
  if (!m) return null;
  const [, stem, end] = m;
  const pres = end === "ar" ? ["o","as","a","amos","áis","an"]
             : end === "er" ? ["o","es","e","emos","éis","en"]
             :                ["o","es","e","imos","ís","en"];
  const pret = end === "ar" ? ["é","aste","ó","amos","asteis","aron"]
             :                ["í","iste","ió","imos","isteis","ieron"];
  return { pres: pres.map(e => stem + e), pret: pret.map(e => stem + e) };
}

function renderConjGrid(container, forms) {
  container.innerHTML = "";
  // Layout: [yo, nosotros, tú, vosotros, él/ella, ellos] (left col then right col, row by row)
  const order = [0, 3, 1, 4, 2, 5];
  order.forEach(i => {
    const pronoun = document.createElement("span");
    pronoun.className = "conj-pronoun";
    pronoun.textContent = CONJ_PRONOUNS[i];
    const form = document.createElement("span");
    form.className = "conj-form";
    form.textContent = forms[i];
    container.appendChild(pronoun);
    container.appendChild(form);
  });
}

function renderConjPanel(card) {
  const panel = $("detail-conj-panel");
  if (card.pos !== "verb") { panel.classList.add("hidden"); return; }
  const conj = getConjugation(card.es);
  if (!conj) { panel.classList.add("hidden"); return; }
  renderConjGrid($("detail-conj-presente"), conj.pres);
  renderConjGrid($("detail-conj-preterito"), conj.pret);
  panel.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Word detail
// ---------------------------------------------------------------------------
let selectedDetailCard = null;
let detailReturnScreen = "screen-browse";

function detailSourceText(card) {
  if (!card.lesson_id) return "Example from the core deck";
  const lesson = LESSON_BY_ID.get(card.lesson_id);
  const manual = card.manual_reference;
  const parts = [`FSI Cycle ${lesson ? lesson.number : ""}`.trim()];
  if (manual && manual.pdf_page) parts.push(`manual PDF p. ${manual.pdf_page}`);
  return parts.join(" · ");
}

function renderDetailDeckButton() {
  const inDeck = selectedDetailCard && isInDeck(selectedDetailCard);
  const button = $("btn-detail-deck");
  button.textContent = inDeck ? "✓" : "+";
  button.classList.toggle("off", !inDeck);
  button.setAttribute("aria-label", inDeck ? "Remove from deck" : "Add to deck");
}

function openWordDetail(card, returnScreen = "screen-browse") {
  selectedDetailCard = card;
  detailReturnScreen = returnScreen;
  const status = cardStatus(card);
  $("detail-word").textContent = card.es;
  $("detail-pos").textContent = `${card.pos} · ${card.cat}`;
  $("detail-translation").textContent = card.en;
  $("detail-meaning-panel").classList.add("hidden");
  $("btn-detail-english").textContent = "Show English";
  $("detail-definition").textContent = card.def || "";
  $("detail-definition").classList.toggle("hidden", !card.def);
  renderVisualCue($("detail-visual"), card.visual_cue);
  $("detail-visual-panel").classList.toggle("hidden", !card.visual_cue);
  $("detail-visual-alt").textContent = card.visual_cue ? card.visual_cue.alt_es : "";
  $("detail-example-es").textContent = card.x || "No contextual example yet.";
  $("detail-example-en").textContent = card.y || "";
  $("detail-example-en").classList.add("hidden");
  $("detail-example-panel").classList.toggle("hidden", !card.x && card.audio_start == null);
  $("btn-detail-audio").classList.toggle("hidden", card.audio_start == null);
  prepareCardAudio(card);
  $("detail-source").textContent = detailSourceText(card);
  const statusEl = $("detail-status");
  statusEl.className = `browse-status ${status.cls}`;
  statusEl.textContent = status.label;
  renderDetailDeckButton();
  renderConjPanel(card);
  show("screen-word-detail");
}

function toggleDetailDeck() {
  if (!selectedDetailCard) return;
  const state = getCardState(selectedDetailCard.id);
  progress[selectedDetailCard.id] = Object.assign({}, state, {
    in_deck: !isInDeck(selectedDetailCard),
  });
  saveUser();
  renderDetailDeckButton();
  const status = cardStatus(selectedDetailCard);
  $("detail-status").className = `browse-status ${status.cls}`;
  $("detail-status").textContent = status.label;
}

// ---------------------------------------------------------------------------
// Progress and portable backup
// ---------------------------------------------------------------------------
function recentDayKeys(count) {
  const days = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    days.push(new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10));
  }
  return days;
}

function renderProgress() {
  const sevenDaysAgo = Date.now() - 7 * DAY_MS;
  const recentReviews = user.review_events.filter(event => event.reviewed_at >= sevenDaysAgo);
  const recalled = recentReviews.filter(event => event.rating !== "again").length;
  $("progress-retention").textContent = recentReviews.length
    ? `${Math.round(recalled / recentReviews.length * 100)}%`
    : "—";
  $("progress-reviews").textContent = user.review_events.length;
  $("progress-mature").textContent = Object.values(progress)
    .filter(state => state.reps >= 2 && state.interval >= 21).length;

  const startedLessons = new Set();
  DATA.forEach(card => {
    const state = progress[card.id];
    if (card.lesson_id && state && state.reps > 0) startedLessons.add(card.lesson_id);
  });
  $("progress-lessons").textContent = startedLessons.size;
  $("progress-hints").textContent = user.hint_events.length;
  $("progress-audio").textContent = user.audio_events.length;
  $("progress-quizzes").textContent = user.quiz_events.length;
  $("progress-streak").textContent = `${stats.streak || 0} day${stats.streak === 1 ? "" : "s"}`;

  const days = recentDayKeys(7);
  const totals = days.map(day => user.review_events
    .filter(event => new Date(event.reviewed_at).toISOString().slice(0, 10) === day).length);
  const max = Math.max(1, ...totals);
  $("progress-week-total").textContent = `${totals.reduce((sum, n) => sum + n, 0)} reviews`;
  $("progress-week-chart").innerHTML = days.map((day, index) => {
    const height = Math.max(totals[index] ? 12 : 3, Math.round(totals[index] / max * 82));
    const label = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "narrow" });
    return `<div class="week-day">
      <span class="week-value">${totals[index] || ""}</span>
      <div class="week-bar" style="height:${height}px"></div>
      <span class="week-label">${label}</span>
    </div>`;
  }).join("");
}

function exportProgress() {
  saveUser();
  const backup = {
    format: "espanol-srs-backup",
    version: 1,
    exported_at: new Date().toISOString(),
    user,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `espanol-srs-backup-${todayStr()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  $("backup-status").textContent = "Backup exported.";
}

function importProgress(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const backup = JSON.parse(reader.result);
      if (backup.format !== "espanol-srs-backup" || !backup.user || backup.user.schema_version !== 2) {
        throw new Error("This is not a valid Español SRS backup.");
      }
      if (!backup.user.cards || !Array.isArray(backup.user.review_events)) {
        throw new Error("The backup is missing progress data.");
      }
      saveJSON(LS_USER, backup.user);
      $("backup-status").textContent = "Progress restored. Reloading…";
      setTimeout(() => location.reload(), 400);
    } catch (error) {
      $("backup-status").textContent = error.message || "Could not restore this backup.";
    }
  };
  reader.onerror = () => { $("backup-status").textContent = "Could not read this backup."; };
  reader.readAsText(file);
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
  LEXEME_BY_ID = new Map(entities.lexemes.map(row => [row.id, row]));
  OCCURRENCE_BY_ID = new Map(entities.occurrences.map(row => [row.id, row]));
  LESSON_BY_ID = new Map(entities.lessons.map(row => [row.id, row]));
  SEGMENT_BY_ID = new Map(entities.segments.map(row => [row.id, row]));
  VISUAL_BY_LEXEME = new Map();
  (entities.visual_cues || []).forEach(cue => {
    if (!VISUAL_BY_LEXEME.has(cue.lexeme_id)) VISUAL_BY_LEXEME.set(cue.lexeme_id, cue);
  });
  const cardByLexeme = new Map();
  entities.cards.forEach(card => {
    if (!cardByLexeme.has(card.lexeme_id)) cardByLexeme.set(card.lexeme_id, card);
  });

  DATA = entities.cards.map(card => {
    const lexeme = LEXEME_BY_ID.get(card.lexeme_id);
    const occurrence = OCCURRENCE_BY_ID.get(card.example_occurrence_ids[0]);
    const lesson = occurrence && occurrence.lesson_id
      ? LESSON_BY_ID.get(occurrence.lesson_id)
      : null;
    const sourceSegment = occurrence && occurrence.segment_ids.length
      ? SEGMENT_BY_ID.get(occurrence.segment_ids[0])
      : null;
    return {
      id: card.id,
      lexeme_id: lexeme.id,
      es: card.prompt,
      en: card.answer,
      pos: lexeme.part_of_speech,
      cat: lexeme.categories[0] || "uncategorized",
      def: lexeme.definition_es,
      x: cleanFsiExample(occurrence ? occurrence.text_es : ""),
      y: occurrence ? occurrence.text_en : "",
      occurrence_id: occurrence ? occurrence.id : null,
      lesson_id: occurrence ? occurrence.lesson_id : null,
      manual_reference: sourceSegment ? sourceSegment.manual_reference : null,
      visual_cue: VISUAL_BY_LEXEME.get(lexeme.id) || null,
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
        const lexeme = LEXEME_BY_ID.get(link.lexeme_id);
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
  screens["screen-word-detail"]  = $("screen-word-detail");
  screens["screen-settings"]     = $("screen-settings");
  screens["screen-progress"]     = $("screen-progress");
  screens["screen-quiz"]         = $("screen-quiz");

  const contentRes = await fetch("app_data_v2.json");
  buildRuntimeViews(await contentRes.json());
  migrateV1UserState();

  renderHome();

  // Home
  $("btn-start").addEventListener("click", startSession);
  $("btn-study-category").addEventListener("click", startCategoryDrill);
  $("btn-quiz").addEventListener("click", startQuiz);
  $("btn-all-cycles").addEventListener("click", openCyclesList);
  $("btn-course-list-link").addEventListener("click", openCyclesList);
  $("btn-browse").addEventListener("click", () => { show("screen-browse"); renderCategoryChips(); renderBrowseList(); });
  $("btn-progress").addEventListener("click", () => { renderProgress(); show("screen-progress"); });
  $("btn-settings").addEventListener("click", () => {
    renderSettings();
    $("settings-content-count").textContent = `${DATA.length} words & phrases · SM-2 spaced repetition`;
    show("screen-settings");
  });

  // Review
  $("btn-exit-review").addEventListener("click", () => { show("screen-home"); renderHome(); });
  $("card").addEventListener("click", () => { if (!$("card").classList.contains("flipped")) flipCard(); });
  $("card").addEventListener("keydown", event => {
    if ((event.key === "Enter" || event.key === " ") && !$("card").classList.contains("flipped")) {
      event.preventDefault();
      flipCard();
    }
  });
  document.querySelectorAll(".rate-btn").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); rate(btn.dataset.q); });
  });
  $("card-audio-btn").addEventListener("click", e => { e.stopPropagation(); playCardAudio(currentCard); });
  $("card-english-btn").addEventListener("click", event => {
    event.stopPropagation();
    const panel = $("card-english");
    const revealing = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !revealing);
    $("card-english-btn").textContent = revealing ? "Hide English" : "Show English";
    if (revealing) revealEnglish(currentCard, "review");
  });

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

  // Word detail
  $("btn-detail-back").addEventListener("click", () => {
    if (detailReturnScreen === "screen-browse") {
      show("screen-browse");
      renderCategoryChips();
      renderBrowseList();
    } else {
      show(detailReturnScreen);
    }
  });
  $("btn-detail-deck").addEventListener("click", toggleDetailDeck);
  $("btn-detail-audio").addEventListener("click", () => playCardAudio(selectedDetailCard));
  $("btn-practice-word").addEventListener("click", () => {
    if (!selectedDetailCard) return;
    if (!isInDeck(selectedDetailCard)) toggleDetailDeck();
    startFocusedSession(selectedDetailCard);
  });
  $("btn-detail-english").addEventListener("click", () => {
    if (!selectedDetailCard) return;
    const panel = $("detail-meaning-panel");
    const revealing = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !revealing);
    $("detail-example-en").classList.toggle("hidden", !revealing || !selectedDetailCard.y);
    $("btn-detail-english").textContent = revealing ? "Hide English" : "Show English";
    if (revealing) revealEnglish(selectedDetailCard, "word_detail");
  });

  // Settings
  $("btn-settings-back").addEventListener("click", () => { saveSettings(); show("screen-home"); renderHome(); });
  $("setting-new-per-day").addEventListener("change", saveSettings);
  $("btn-reset-progress").addEventListener("click", () => {
    if (confirm("Reset all progress? This cannot be undone.")) {
      progress = {};
      stats = { streak: 0, last_study_day: null, total_reviews: 0, history: {} };
      user.cards = progress;
      user.review_events = [];
      user.hint_events = [];
      user.audio_events = [];
      user.quiz_events = [];
      user.lesson_progress = {};
      saveUser();
      show("screen-home");
      renderHome();
    }
  });

  // Progress and backup
  $("btn-progress-back").addEventListener("click", () => { show("screen-home"); renderHome(); });
  $("btn-export-progress").addEventListener("click", exportProgress);
  $("btn-import-progress").addEventListener("click", () => $("input-import-progress").click());
  $("input-import-progress").addEventListener("change", event => {
    importProgress(event.target.files && event.target.files[0]);
    event.target.value = "";
  });

  // Cloze quiz
  $("btn-quiz-exit").addEventListener("click", () => { show("screen-home"); renderHome(); });
  $("btn-quiz-audio").addEventListener("click", () => playCardAudio(quizCard));
  $("btn-quiz-hint").addEventListener("click", showQuizHint);
  $("btn-quiz-check").addEventListener("click", checkQuizAnswer);
  $("quiz-answer").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      checkQuizAnswer();
    }
  });
  $("btn-quiz-next").addEventListener("click", () => {
    quizIndex += 1;
    renderQuizQuestion();
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
