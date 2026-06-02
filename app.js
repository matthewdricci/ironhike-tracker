// IronHike 2026 — Live lap tracker dashboard
//
// Production reads laps from the Cloudflare Worker /laps?event=ironhike endpoint.
// Simulation: append ?sim=NAME (see sim/index.html) to load pre-baked QA CSVs.
// Time-travel: append ?simNow=2026-06-05T18:00:00-04:00 to pretend "now" is that moment.

const REFRESH_MS    = 60_000;
const REST_MIN      = 45; // minutes between summits before status flips to "Resting"
const DUP_SEC       = 45; // consecutive timestamps closer than this look like accidental double-taps

// Self-hosted Cloudflare Worker — laps API + Web Push.
const PUSH_WORKER_URL  = "https://ironhike-push.beyond-the-hudson-918.workers.dev";
const LAPS_URL         = `${PUSH_WORKER_URL}/laps?event=ironhike`;
const VAPID_PUBLIC_KEY = "BF9wwg-Dj93wNjIPdXisxSNg5wJpzHVD62Jag-HttBRiS1RZ1VmQgMvo0kTLHeFSrV9F7ca2xT0-PTQ42YxVqR0";

// ---------- sim / time-travel ----------
const params = new URLSearchParams(location.search);
const SIM_NAME = params.get("sim");
let SIM_NOW = null;
if (params.get("simNow")) {
  const d = new Date(params.get("simNow"));
  if (!isNaN(d)) SIM_NOW = d;
}
const SIM_LAPS_CSV_URL   = SIM_NAME ? `./sim/${SIM_NAME}-laps.csv`   : null;
const SIM_CONFIG_CSV_URL = SIM_NAME ? `./sim/${SIM_NAME}-config.csv` : null;
function getNow() { return SIM_NOW ? new Date(SIM_NOW.getTime()) : new Date(); }

// Event config is fixed (race-director-controlled). Sim CSVs can override it for time-travel testing.
const CONFIG = {
  start_iso:            "2026-06-04T12:00:00-04:00",
  cutoff_iso:           "2026-06-07T12:00:00-04:00",
  ideal_iso:            "2026-06-06T12:00:00-04:00",   // ideal finish — drive home Sat in daylight
  total_laps:           49,
  elevation_ft_per_lap: 595,
  athlete_name:         "Matt Ricci",
};

// ---------- data ----------

async function fetchLapsFromWorker() {
  const r = await fetch(LAPS_URL + "&cachebust=" + Date.now());
  if (!r.ok) throw new Error("fetch " + LAPS_URL + " → " + r.status);
  const json = await r.json();
  const out = [];
  for (const row of (json.laps || [])) {
    const d = new Date(row.timestamp_iso);
    if (!isNaN(d)) out.push({ t: d, note: (row.note || "").trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function fetchCsv(url) {
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "cachebust=" + Date.now());
  if (!r.ok) throw new Error("fetch " + url + " → " + r.status);
  return parseCsv(await r.text());
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function applyConfigCsv(rows) {
  for (const r of rows) {
    if (!r || r.length < 2) continue;
    const k = (r[0] || "").trim();
    const v = (r[1] || "").trim();
    if (!k || k.toLowerCase() === "key") continue;
    if (k === "total_laps" || k === "elevation_ft_per_lap") CONFIG[k] = Number(v);
    else CONFIG[k] = v;
  }
}

function lapsFromCsv(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r[0]) continue;
    const ts = r[0].trim();
    if (!ts || ts.toLowerCase().startsWith("timestamp")) continue;
    const d = new Date(ts);
    if (!isNaN(d)) out.push({ t: d, note: (r[1] || "").trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------- formatting ----------

const pad = n => (n < 10 ? "0" + n : "" + n);

function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return "—";
  const sign = ms < 0 ? "-" : "";
  ms = Math.abs(ms);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 1) return `${sign}${h}h ${pad(m)}m`;
  const s = Math.floor((ms % 60_000) / 1000);
  return `${sign}${m}m ${pad(s)}s`;
}

function fmtPerLap(ms) {
  if (ms == null || isNaN(ms) || !isFinite(ms) || ms <= 0) return "—";
  return "1 / " + fmtDur(ms);
}

const fmtInt = n => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

// ---------- render ----------

let chart = null;

function render(laps) {
  const now = getNow();
  const start = new Date(CONFIG.start_iso);
  const cutoff = new Date(CONFIG.cutoff_iso);
  const ideal = CONFIG.ideal_iso ? new Date(CONFIG.ideal_iso) : null;
  const total = CONFIG.total_laps;
  const ft = CONFIG.elevation_ft_per_lap;

  const done = laps.length;
  const remainingLaps = Math.max(0, total - done);
  const elapsedMs = now - start;
  const cutoffMs  = cutoff - now;

  document.getElementById("title").textContent = `IronHike 2026 — ${CONFIG.athlete_name}`;
  document.getElementById("laps-done").textContent  = done;
  document.getElementById("laps-total").textContent = total;
  document.getElementById("elevation").textContent  = `${fmtInt(done * ft)} ft / ${fmtInt(total * ft)} ft`;
  const pct = total ? (done / total) * 100 : 0;
  document.getElementById("percent").textContent = pct.toFixed(1) + "%";
  document.getElementById("progress-bar").style.width = Math.min(100, pct) + "%";

  document.getElementById("elapsed").textContent   = elapsedMs > 0 ? fmtDur(elapsedMs) : "not started";
  document.getElementById("remaining").textContent = cutoffMs > 0 ? fmtDur(cutoffMs) : "CUTOFF PASSED";

  // Budget per lap (used for both the BUFFER projection and NEXT LAP DUE BY deadline).
  const budgetMs = remainingLaps > 0 && cutoffMs > 0 ? cutoffMs / remainingLaps : null;
  const actualMs = done > 0 && elapsedMs > 0 ? elapsedMs / done : null;

  // BUFFER: projected finish vs cutoff, using cumulative pace.
  const bufferBox = document.getElementById("buffer-box");
  const bufferEl  = document.getElementById("buffer");
  const bufferNote = document.getElementById("buffer-note");
  bufferBox.classList.remove("good", "bad");
  if (done === 0 || actualMs == null) {
    bufferEl.textContent = "—";
    bufferNote.textContent = "starts updating after lap 1";
  } else if (remainingLaps === 0) {
    bufferEl.textContent = "FINISHED";
    bufferBox.classList.add("good");
    bufferNote.textContent = "at " + laps[laps.length-1].t.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } else if (cutoffMs <= 0) {
    bufferEl.textContent = "CUTOFF PASSED";
    bufferBox.classList.add("bad");
    bufferNote.textContent = `${done}/${total} laps completed`;
  } else {
    const projectedFinish = new Date(now.getTime() + remainingLaps * actualMs);
    const buf = cutoff - projectedFinish;
    bufferEl.textContent = (buf >= 0 ? "+" : "−") + fmtDur(Math.abs(buf)) + (buf >= 0 ? " ahead" : " behind");
    bufferBox.classList.add(buf >= 0 ? "good" : "bad");
    bufferNote.textContent = "projected finish " + projectedFinish.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // NEXT LAP DUE BY: wall-clock deadline for the next lap based on budget.
  const dueEl  = document.getElementById("due-by");
  const dueNote = document.getElementById("due-note");
  if (remainingLaps === 0) {
    dueEl.textContent = "—";
    dueNote.textContent = "all laps complete";
  } else if (cutoffMs <= 0) {
    dueEl.textContent = "—";
    dueNote.textContent = "cutoff passed";
  } else if (elapsedMs <= 0) {
    dueEl.textContent = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    dueNote.textContent = "event start";
  } else {
    const dueAt = new Date(now.getTime() + budgetMs);
    dueEl.textContent = dueAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    dueNote.textContent = `${fmtDur(budgetMs)} from now — your running budget`;
  }

  // Last summit + status
  if (done > 0) {
    const last = laps[laps.length - 1].t;
    const since = now - last;
    document.getElementById("last-summit").textContent = fmtDur(since) + " ago";
    const isResting = since > REST_MIN * 60_000;
    document.getElementById("status").textContent = isResting ? `Resting — ${fmtDur(since)}` : "Active";
  } else {
    document.getElementById("last-summit").textContent = "—";
    document.getElementById("status").textContent = elapsedMs < 0 ? "pre-event" : "waiting for lap 1";
  }

  // For burn-down chart color: are we currently ahead (less remaining than required)?
  let ahead = null;
  if (start && cutoff && done > 0 && cutoffMs > 0) {
    const requiredRemaining = total * (cutoff - now) / (cutoff - start);
    const actualRemaining   = total - done;
    ahead = actualRemaining < requiredRemaining;
  }

  renderDupes(laps);
  renderChart(start, cutoff, ideal, total, laps, now, ahead);

  document.getElementById("updated").textContent =
    "updated " + now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function renderDupes(laps) {
  const wrap = document.getElementById("dupes");
  if (!wrap) return;
  const pairs = [];
  for (let i = 1; i < laps.length; i++) {
    const gap = (laps[i].t - laps[i-1].t) / 1000;
    if (gap < DUP_SEC) pairs.push({ a: i, b: i + 1, gap });
  }
  if (pairs.length === 0) { wrap.hidden = true; wrap.innerHTML = ""; return; }
  wrap.hidden = false;
  wrap.innerHTML = `
    <div class="k">POSSIBLE DUPLICATE${pairs.length > 1 ? "S" : ""}</div>
    <div class="v">${pairs.map(p => `row ${p.a} &amp; ${p.b} <span class="thin">(${p.gap.toFixed(0)}s apart)</span>`).join("<br>")}</div>
    <div class="note">If accidental, use the "Undo IronHike Lap" shortcut on your phone.</div>
  `;
}

function renderChart(start, cutoff, ideal, total, laps, now, ahead) {
  const ctx = document.getElementById("chart");

  // Burn-down: stairsteps DOWN from total toward 0.
  const stepPts = [{ x: start, y: total }];
  laps.forEach((lap, i) => {
    stepPts.push({ x: lap.t, y: total - i });
    stepPts.push({ x: lap.t, y: total - (i + 1) });
  });
  if (laps.length > 0 && now > laps[laps.length - 1].t) {
    stepPts.push({ x: now, y: total - laps.length });
  } else if (laps.length === 0 && now > start) {
    stepPts.push({ x: now, y: total });
  }

  // Deadline pace: (start, total) → (cutoff, 0). Hitting zero = done in time.
  const required = [{ x: start, y: total }, { x: cutoff, y: 0 }];
  // Ideal pace: (start, total) → (ideal, 0). Finishing here = drive home Sat in daylight.
  const idealLine = ideal ? [{ x: start, y: total }, { x: ideal, y: 0 }] : null;

  // Real burn-down is fixed amber; the two dashed target lines own red/green.
  // Read ahead/behind by where the amber line sits relative to the targets.
  const datasets = [
    {
      label: "Remaining",
      data: stepPts,
      borderColor: "#ffb648",
      backgroundColor: "rgba(255, 182, 72, 0.15)",
      borderWidth: 2.5,
      pointRadius: 0,
      fill: true,
      tension: 0,
    },
    {
      label: "Deadline (Sun 12p)",
      data: required,
      borderColor: "#f87171",
      borderDash: [6, 6],
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0,
    },
    ...(idealLine ? [{
      label: "Ideal (Sat 12p)",
      data: idealLine,
      borderColor: "#4ade80",
      borderDash: [2, 4],
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0,
    }] : []),
  ];

  if (chart) {
    chart.data.datasets = datasets;
    chart.options.scales.x.min = start;
    chart.options.scales.x.max = cutoff;
    chart.options.scales.y.max = total;
    chart.update("none");
    return;
  }

  chart = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { color: "#f2f4f7", boxWidth: 18, font: { size: 11 }, usePointStyle: false },
        },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          type: "time",
          min: start,
          max: cutoff,
          time: { unit: "hour", displayFormats: { hour: "EEE ha" } },
          ticks: { color: "#98a2af", font: { size: 10 }, maxRotation: 0, autoSkipPadding: 16 },
          grid: { color: "#262c34" },
        },
        y: {
          min: 0,
          max: total,
          ticks: { color: "#98a2af", font: { size: 10 }, stepSize: 10 },
          grid: { color: "#262c34" },
        },
      },
    },
  });
}

// ---------- sim banner ----------

function installSimBanner() {
  if (!SIM_NAME && !SIM_NOW) return;
  const b = document.createElement("div");
  b.id = "sim-banner";
  const parts = [];
  if (SIM_NAME) parts.push(`SIM: ${SIM_NAME}`);
  if (SIM_NOW) parts.push(`now = ${SIM_NOW.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
  b.innerHTML = parts.join(" · ") + ' · <a href="./">exit</a>';
  document.body.prepend(b);
}
installSimBanner();

// ---------- Web Push subscribe ----------
//
// Standard Web Push API: registers our service worker, asks for permission,
// calls pushManager.subscribe() with our VAPID public key, POSTs the resulting
// subscription to the Worker.

async function installPushSubscribe() {
  if (SIM_NAME || SIM_NOW) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith("REPLACE_WITH")) return;

  const btn = document.getElementById("push-btn");
  if (!btn) return;

  let reg;
  try {
    reg = await navigator.serviceWorker.register("./sw.js");
  } catch (e) {
    console.error("SW register failed", e);
    return;
  }

  const refresh = async () => {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      btn.textContent = "🔔 Subscribed — you'll get a push each lap";
      btn.classList.add("subscribed");
    } else {
      btn.textContent = "🔔 Turn on race notifications";
      btn.classList.remove("subscribed");
    }
    btn.hidden = false;
  };

  btn.onclick = async () => {
    // Context-aware: in regular Safari, iOS web push is unreliable outside
    // standalone mode. Redirect to the install instructions instead of
    // attempting a subscribe that may silently fail or look successful
    // without actually delivering pushes.
    if (!isInstalledPWA()) {
      showWelcomeOverlay();
      return;
    }

    btn.disabled = true;
    try {
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch(PUSH_WORKER_URL + "/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        });
        await existing.unsubscribe();
      } else {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") return;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        const json = sub.toJSON();
        await fetch(PUSH_WORKER_URL + "/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          }),
        });
      }
      await refresh();
    } catch (e) {
      console.error("push subscribe failed", e);
      alert("Push subscription failed: " + (e.message || e));
    } finally {
      btn.disabled = false;
    }
  };

  await refresh();
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

installPushSubscribe();

// ---------- welcome / install overlay ----------
//
// Goal: someone who only has the URL (e.g. Matt's mom) opens it and immediately
// understands they should install the PWA + tap the bell. Shown to first-time
// mobile visitors. Hidden if: simulating, already installed as PWA, or the user
// dismissed it before.

const WELCOME_DISMISSED_KEY = "ironhike-welcome-dismissed-v1";

function isInstalledPWA() {
  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
  if (navigator.standalone === true) return true;
  return false;
}

function detectPlatform() {
  const ua = navigator.userAgent || "";
  const isIPad = /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (/iPhone|iPod/.test(ua) || isIPad) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

let _deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
});

function initWelcome() {
  // Skip in sim or time-travel mode — those are dev tools, not user flows.
  if (SIM_NAME || SIM_NOW) return;
  // Wire up the close + install buttons regardless — needed whether the
  // welcome is shown automatically or re-opened later from the bell tap.
  wireWelcomeControls();
  if (isInstalledPWA()) return;
  if (localStorage.getItem(WELCOME_DISMISSED_KEY)) return;
  showWelcomeOverlay();
}

// Show the welcome overlay regardless of localStorage/PWA state. Used by the
// bell button when tapped in regular Safari — push subscription is unreliable
// outside standalone mode, so we redirect them to the install instructions.
function showWelcomeOverlay() {
  const overlay = document.getElementById("welcome");
  if (!overlay) return;

  const platform = detectPlatform();
  const panels = {
    ios:     document.getElementById("welcome-ios"),
    android: document.getElementById("welcome-android"),
    desktop: document.getElementById("welcome-desktop"),
  };
  // Hide all panels first, then show just the active one — keeps re-opens clean.
  for (const k in panels) if (panels[k]) panels[k].hidden = true;
  const active = panels[platform] || panels.desktop;
  if (active) active.hidden = false;

  overlay.hidden = false;
}

function wireWelcomeControls() {
  const closeBtn = document.getElementById("welcome-close");
  if (closeBtn) closeBtn.onclick = dismissWelcome;

  const installBtn = document.getElementById("welcome-install-btn");
  if (installBtn) {
    installBtn.onclick = async () => {
      if (!_deferredInstallPrompt) {
        alert("Install prompt isn't available in this browser. Open your browser menu (⋮) and look for 'Add to Home Screen' or 'Install app'.");
        return;
      }
      _deferredInstallPrompt.prompt();
      const choice = await _deferredInstallPrompt.userChoice;
      _deferredInstallPrompt = null;
      if (choice.outcome === "accepted") dismissWelcome();
    };
  }
}

function dismissWelcome() {
  localStorage.setItem(WELCOME_DISMISSED_KEY, String(Date.now()));
  const overlay = document.getElementById("welcome");
  if (overlay) overlay.hidden = true;
}

// Now that all welcome-related consts and functions are defined, run init.
// (Was previously called above with installPushSubscribe(), which triggered
// a temporal-dead-zone ReferenceError on WELCOME_DISMISSED_KEY and silently
// broke the welcome screen on every load.)
initWelcome();


// ---------- main loop ----------

async function tick() {
  try {
    let laps;
    if (SIM_NAME) {
      const [cfgRows, lapRows] = await Promise.all([
        fetchCsv(SIM_CONFIG_CSV_URL),
        fetchCsv(SIM_LAPS_CSV_URL),
      ]);
      applyConfigCsv(cfgRows);
      laps = lapsFromCsv(lapRows);
    } else {
      laps = await fetchLapsFromWorker();
    }
    render(laps);
  } catch (e) {
    console.error(e);
    document.getElementById("updated").textContent = "fetch error — retrying";
  }
}

tick();
setInterval(tick, REFRESH_MS);
document.addEventListener("click", tick);
