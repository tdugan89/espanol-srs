const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

(async () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const dataJson = fs.readFileSync(path.join(__dirname, "data.json"), "utf8");

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    resources: "usable",
  });

  const { window } = dom;

  // stub fetch to serve local data.json (jsdom has no real network fetch by default)
  window.fetch = async (url) => {
    if (url.includes("data.json")) {
      return { json: async () => JSON.parse(dataJson) };
    }
    return { json: async () => ({}) };
  };
  // stub localStorage (jsdom provides one, but ensure clean)
  window.localStorage.clear();
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

  console.log("=== HOME SCREEN ===");
  console.log("due:", byId("stat-due").textContent);
  console.log("new:", byId("stat-new").textContent);
  console.log("streak:", byId("stat-streak").textContent);
  console.log("learned:", byId("stat-learned").textContent);
  console.log("start button text:", byId("btn-start").textContent);

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
  console.log("translation shown:", byId("card-translation").textContent);
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

  const progress = JSON.parse(window.localStorage.getItem("esrs_progress_v1"));
  const numTracked = Object.keys(progress).length;
  console.log("cards tracked in localStorage:", numTracked);
  if (numTracked < 1) throw new Error("No progress was saved!");

  console.log("\n=== BROWSE SCREEN ===");
  byId("btn-browse").click();
  await new Promise((r) => setTimeout(r, 20));
  console.log("browse items rendered:", doc.querySelectorAll(".browse-item").length);
  byId("browse-search").value = "hola";
  byId("browse-search").dispatchEvent(new window.Event("input"));
  await new Promise((r) => setTimeout(r, 20));
  console.log('items after searching "hola":', doc.querySelectorAll(".browse-item").length);

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
  const settings = JSON.parse(window.localStorage.getItem("esrs_settings_v1"));
  console.log("saved settings:", settings);
  if (settings.newPerDay !== 10) throw new Error("Settings did not persist correctly");

  console.log("\nALL TESTS PASSED");
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
