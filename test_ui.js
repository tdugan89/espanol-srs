const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

(async () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const appDataJson = fs.readFileSync(path.join(__dirname, "app_data_v2.json"), "utf8");

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    resources: "usable",
  });

  const { window } = dom;
  const fakeAudioInstances = [];
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.dataset = {};
      this.currentTime = 0;
      this.duration = 1000;
      this.readyState = 0;
      this.paused = true;
      this.listeners = {};
      this.playCalls = 0;
      fakeAudioInstances.push(this);
    }
    addEventListener(type, handler, options = {}) {
      (this.listeners[type] ||= []).push({ handler, once: !!options.once });
    }
    emit(type) {
      const current = (this.listeners[type] || []).slice();
      this.listeners[type] = (this.listeners[type] || []).filter(item => !item.once);
      current.forEach(item => item.handler());
    }
    load() {}
    pause() { this.paused = true; }
    play() {
      this.paused = false;
      this.playCalls++;
      return Promise.resolve();
    }
  }
  window.Audio = FakeAudio;

  // Stub the generated v2 runtime bundle.
  window.fetch = async (url) => {
    if (url === "app_data_v2.json") {
      return { json: async () => JSON.parse(appDataJson) };
    }
    throw new Error("Unexpected fetch: " + url);
  };
  // stub localStorage (jsdom provides one, but ensure clean)
  window.localStorage.clear();
  // Seed one v1 review to prove first-launch migration preserves it.
  window.localStorage.setItem("esrs_progress_v1", JSON.stringify({
    "0": {
      reps: 2,
      interval: 6,
      ef: 2.4,
      due: Date.now() + 86400000,
      lapses: 1,
      firstSeen: "2026-06-01",
    },
  }));
  window.localStorage.setItem("esrs_settings_v1", JSON.stringify({ newPerDay: 20 }));
  window.localStorage.setItem("esrs_stats_v1", JSON.stringify({
    streak: 2,
    lastStudyDay: "2026-06-27",
    totalReviews: 4,
    history: { "2026-06-27": 4 },
  }));
  // navigator.serviceWorker may not exist in jsdom -> guard
  if (!window.navigator.serviceWorker) {
    window.navigator.serviceWorker = { register: async () => ({}) };
  }

  // inject app.js manually since jsdom's <script src> loading for local files can be flaky
  const appJs = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  const scriptEl = window.document.createElement("script");
  scriptEl.textContent = appJs;
  window.document.body.appendChild(scriptEl);

  // give init() (async) a tick to run
  await new Promise((r) => setTimeout(r, 50));

  const doc = window.document;
  const byId = (id) => doc.getElementById(id);
  const content = JSON.parse(appDataJson);
  if (content.schema_version !== 2) throw new Error("Expected content schema v2");
  if (content.entities.lexemes.length !== 912) throw new Error("Expected 912 lexemes");
  if (content.entities.lessons.length !== 38) throw new Error("Expected 38 lessons");

  console.log("=== HOME SCREEN ===");
  console.log("due:", byId("stat-due").textContent);
  console.log("new:", byId("stat-new").textContent);
  console.log("streak:", byId("stat-streak").textContent);
  console.log("learned:", byId("stat-learned").textContent);
  console.log("start button text:", byId("btn-start").textContent);
  if (doc.querySelectorAll(".home-category-chip").length !== 6) {
    throw new Error("Expected six home practice filters");
  }
  if (!byId("current-cycle-card").textContent.trim()) {
    throw new Error("Continue-course card did not render");
  }
  const migratedUser = JSON.parse(window.localStorage.getItem("esrs_user_v2"));
  if (migratedUser.migrated_from !== "v1") throw new Error("v1 state was not migrated");
  if (migratedUser.cards["card:legacy:0000"].reps !== 2) {
    throw new Error("Legacy numeric card ID did not map to its stable v2 ID");
  }

  if (byId("stat-new").textContent !== "20") {
    throw new Error("Expected 20 new cards available by default, got " + byId("stat-new").textContent);
  }

  console.log("\n=== START SESSION ===");
  byId("btn-start").click();
  await new Promise((r) => setTimeout(r, 20));
  const reviewScreen = byId("screen-review");
  if (reviewScreen.classList.contains("hidden")) throw new Error("Review screen did not show");
  console.log("card term shown:", byId("card-term").textContent);
  console.log("remaining:", byId("review-remaining").textContent);

  console.log("\n=== FLIP CARD ===");
  byId("card").click();
  await new Promise((r) => setTimeout(r, 20));
  const flipped = byId("card").classList.contains("flipped");
  console.log("flipped:", flipped);
  console.log("answer shown:", byId("card-definition").textContent);
  if (!byId("card-definition").textContent) throw new Error("Card answer is blank");
  if (byId("rating-row").classList.contains("hidden")) throw new Error("Rating row should be visible after flip");

  console.log("\n=== RATE 'good' REPEATEDLY UNTIL SESSION ENDS ===");
  let loops = 0;
  while (!byId("screen-done") || byId("screen-done").classList.contains("hidden")) {
    // pick a rating button — alternate to exercise more code paths
    const buttons = ["good", "again", "hard", "easy"];
    const q = buttons[loops % buttons.length];
    const btn = doc.querySelector(`.rate-btn[data-q="${q}"]`);
    if (!btn) throw new Error("rating button missing: " + q);
    // card must be flipped to rate in real UI; our app doesn't enforce this in code,
    // but let's flip first to mimic real usage if not flipped
    if (!byId("card").classList.contains("flipped")) byId("card").click();
    btn.click();
    await new Promise((r) => setTimeout(r, 5));
    loops++;
    if (loops > 200) throw new Error("Session did not finish within 200 ratings — possible infinite loop");
  }
  console.log("session finished after", loops, "ratings");
  console.log("done summary:", byId("done-summary").textContent);

  console.log("\n=== BACK TO HOME, CHECK STATE PERSISTED ===");
  byId("btn-done-home").click();
  await new Promise((r) => setTimeout(r, 20));
  console.log("learned after session:", byId("stat-learned").textContent);
  console.log("streak after session:", byId("stat-streak").textContent);

  const user = JSON.parse(window.localStorage.getItem("esrs_user_v2"));
  if (user.schema_version !== 2) throw new Error("Expected user schema v2");
  const numTracked = Object.keys(user.cards).length;
  console.log("cards tracked in localStorage:", numTracked);
  if (numTracked < 1) throw new Error("No progress was saved!");
  if (!user.review_events.length) throw new Error("No review events were recorded");
  if (!Object.keys(user.cards).every(id => id.startsWith("card:"))) {
    throw new Error("Progress is not keyed by stable card IDs");
  }

  console.log("\n=== BROWSE SCREEN ===");
  byId("btn-browse").click();
  await new Promise((r) => setTimeout(r, 20));
  console.log("browse items rendered:", doc.querySelectorAll(".browse-item").length);
  byId("browse-search").value = "hotel";
  byId("browse-search").dispatchEvent(new window.Event("input"));
  await new Promise((r) => setTimeout(r, 20));
  console.log('items after searching "hotel":', doc.querySelectorAll(".browse-item").length);
  const hotelResult = doc.querySelector(".browse-item");
  if (!hotelResult) throw new Error("Expected a browse result for hotel");
  hotelResult.click();
  await new Promise((r) => setTimeout(r, 20));
  if (byId("screen-word-detail").classList.contains("hidden")) {
    throw new Error("Word detail did not open");
  }
  if (byId("detail-word").textContent.toLowerCase() !== "el hotel") {
    throw new Error("Wrong word detail opened");
  }
  if (!byId("detail-visual").querySelector("img")) {
    throw new Error("Curated hotel visual did not render");
  }
  byId("btn-detail-audio").click();
  const hotelAudio = fakeAudioInstances[fakeAudioInstances.length - 1];
  if (hotelAudio.currentTime !== 0 || hotelAudio.playCalls !== 0) {
    throw new Error("Audio started before metadata was ready");
  }
  hotelAudio.readyState = 1;
  hotelAudio.emit("loadedmetadata");
  if (Math.abs(hotelAudio.currentTime - 20.31) > 0.01 || hotelAudio.playCalls !== 1) {
    throw new Error(`Audio did not seek to the clip: ${hotelAudio.currentTime}`);
  }
  if (!byId("detail-meaning-panel").classList.contains("hidden")) {
    throw new Error("English should be hidden initially");
  }
  byId("btn-detail-english").click();
  if (byId("detail-meaning-panel").classList.contains("hidden")) {
    throw new Error("English hint did not reveal");
  }
  const hintedUser = JSON.parse(window.localStorage.getItem("esrs_user_v2"));
  if (!hintedUser.hint_events.length) throw new Error("English hint use was not recorded");
  if (!byId("btn-practice-word").textContent) throw new Error("Practice action missing");
  byId("btn-detail-back").click();
  await new Promise((r) => setTimeout(r, 10));

  console.log("\n=== SETTINGS SCREEN ===");
  byId("btn-browse-back").click();
  await new Promise((r) => setTimeout(r, 10));
  byId("btn-settings").click();
  await new Promise((r) => setTimeout(r, 10));
  console.log("new-per-day input value:", byId("setting-new-per-day").value);
  byId("setting-new-per-day").value = "10";
  byId("setting-new-per-day").dispatchEvent(new window.Event("change"));
  byId("btn-settings-back").click();
  await new Promise((r) => setTimeout(r, 10));
  const savedUser = JSON.parse(window.localStorage.getItem("esrs_user_v2"));
  console.log("saved settings:", savedUser.settings);
  if (savedUser.settings.new_per_day !== 10) throw new Error("Settings did not persist correctly");

  console.log("\n=== COURSE MODEL ===");
  byId("btn-all-cycles").click();
  await new Promise((r) => setTimeout(r, 20));
  if (doc.querySelectorAll(".cycle-row").length !== 38) throw new Error("Expected 38 cycle rows");
  doc.querySelector(".cycle-row").click();
  await new Promise((r) => setTimeout(r, 20));
  if (!doc.querySelectorAll(".seg-line").length) throw new Error("Cycle has no segments");
  if (doc.querySelector(".seg-line").getAttribute("role") !== "button") {
    throw new Error("Transcript segments are not interactive");
  }
  const firstVocab = doc.querySelector(".vocab-row");
  if (!firstVocab) throw new Error("Cycle has no vocabulary");
  firstVocab.click();
  await new Promise((r) => setTimeout(r, 20));
  if (byId("screen-word-detail").classList.contains("hidden")) {
    throw new Error("Cycle vocabulary did not open word detail");
  }
  console.log("cycle segments:", doc.querySelectorAll(".seg-line").length);

  console.log("\nALL TESTS PASSED");
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
