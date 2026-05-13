// IronHike 2026 — Live lap tracker dashboard
//
// SETUP: paste the two published-to-web CSV URLs from your Google Sheet.
// File → Share → Publish to web → choose the tab → CSV.
const LAPS_CSV_URL   = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRTaIypPNTbi03yMGIVJacrZ3P6sUpohgU6o2ulD2jFXeztKu_-pP2ZvOUT-5szUKdNwon3DYWrT18R/pub?gid=182922486&single=true&output=csv";
const CONFIG_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRTaIypPNTbi03yMGIVJacrZ3P6sUpohgU6o2ulD2jFXeztKu_-pP2ZvOUT-5szUKdNwon3DYWrT18R/pub?gid=1079718579&single=true&output=csv";

const REFRESH_MS    = 60_000;
const REST_MIN      = 45; // minutes between summits before status flips to "Resting"

// Fallback config — overridden by values in the `config` sheet tab once it loads.
const FALLBACK_CONFIG = {
  start_iso:            "2026-06-04T12:00:00-04:00",
  cutoff_iso:           "2026-06-07T12:00:00-04:00",
  total_laps:           49,
  elevation_ft_per_lap: 595,
  athlete_name:         "Matt Ricci",
};

// ---------- CSV ----------

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

function configFromCsv(rows) {
  const cfg = { ...FALLBACK_CONFIG };
  for (const r of rows) {
    if (!r || r.length < 2) continue;
    const k = (r[0] || "").trim();
    const v = (r[1] || "").trim();
    if (!k || k.toLowerCase() === "key") continue;
    if (k === "total_laps" || k === "elevation_ft_per_lap") cfg[k] = Number(v);
    else cfg[k] = v;
  }
  return cfg;
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

function render(cfg, laps) {
  const now = new Date();
  const start = new Date(cfg.start_iso);
  const cutoff = new Date(cfg.cutoff_iso);
  const total = cfg.total_laps;
  const ft = cfg.elevation_ft_per_lap;

  const done = laps.length;
  const remainingLaps = Math.max(0, total - done);
  const elapsedMs = now - start;
  const cutoffMs  = cutoff - now;

  document.getElementById("title").textContent = `IronHike 2026 — ${cfg.athlete_name}`;
  document.getElementById("laps-done").textContent  = done;
  document.getElementById("laps-total").textContent = total;
  document.getElementById("elevation").textContent  = `${fmtInt(done * ft)} ft / ${fmtInt(total * ft)} ft`;
  const pct = total ? (done / total) * 100 : 0;
  document.getElementById("percent").textContent = pct.toFixed(1) + "%";
  document.getElementById("progress-bar").style.width = Math.min(100, pct) + "%";

  document.getElementById("elapsed").textContent   = elapsedMs > 0 ? fmtDur(elapsedMs) : "not started";
  document.getElementById("remaining").textContent = cutoffMs > 0 ? fmtDur(cutoffMs) : "CUTOFF PASSED";

  // BUDGET: how often you need to bag a lap from now on to finish on time.
  const budgetMs = remainingLaps > 0 && cutoffMs > 0 ? cutoffMs / remainingLaps : null;
  document.getElementById("budget").textContent = remainingLaps === 0 ? "—" : fmtPerLap(budgetMs);

  // ACTUAL: cumulative pace (includes all rest). Honest, not flattering.
  const actualMs = done > 0 && elapsedMs > 0 ? elapsedMs / done : null;
  document.getElementById("actual").textContent = fmtPerLap(actualMs);

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
    bufferNote.textContent = `at ${laps[laps.length-1].t.toLocaleString()}`;
  } else {
    const projectedFinish = new Date(now.getTime() + remainingLaps * actualMs);
    const buf = cutoff - projectedFinish;
    bufferEl.textContent = (buf >= 0 ? "+" : "") + fmtDur(buf) + (buf >= 0 ? " ahead" : " behind");
    bufferBox.classList.add(buf >= 0 ? "good" : "bad");
    bufferNote.textContent = "projected finish " + projectedFinish.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
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

  renderChart(start, cutoff, total, laps, now);

  document.getElementById("updated").textContent =
    "updated " + now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function renderChart(start, cutoff, total, laps, now) {
  const ctx = document.getElementById("chart");

  // Step series: at each lap timestamp, cumulative count jumps to N.
  const stepPts = [{ x: start, y: 0 }];
  laps.forEach((lap, i) => {
    stepPts.push({ x: lap.t, y: i });       // hold previous value to this point
    stepPts.push({ x: lap.t, y: i + 1 });   // then jump
  });
  // Extend horizontal line to "now" so the curve shows current standing.
  if (laps.length > 0 && now > laps[laps.length - 1].t) {
    stepPts.push({ x: now, y: laps.length });
  } else if (laps.length === 0 && now > start) {
    stepPts.push({ x: now, y: 0 });
  }

  const required = [{ x: start, y: 0 }, { x: cutoff, y: total }];

  const datasets = [
    {
      label: "Required pace",
      data: required,
      borderColor: "rgba(152, 162, 175, 0.7)",
      borderDash: [6, 6],
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0,
    },
    {
      label: "Your progress",
      data: stepPts,
      borderColor: "#ffb648",
      backgroundColor: "rgba(255, 182, 72, 0.15)",
      borderWidth: 2.5,
      pointRadius: 0,
      fill: true,
      tension: 0,
    },
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
        legend: { display: true, labels: { color: "#98a2af", boxWidth: 12, font: { size: 11 } } },
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

// ---------- main loop ----------

async function tick() {
  try {
    const [cfgRows, lapRows] = await Promise.all([
      fetchCsv(CONFIG_CSV_URL),
      fetchCsv(LAPS_CSV_URL),
    ]);
    const cfg  = configFromCsv(cfgRows);
    const laps = lapsFromCsv(lapRows);
    render(cfg, laps);
  } catch (e) {
    console.error(e);
    document.getElementById("updated").textContent = "fetch error — retrying";
  }
}

tick();
setInterval(tick, REFRESH_MS);
document.addEventListener("click", tick);
