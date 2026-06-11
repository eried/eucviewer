(async function () {
  "use strict";

  // Imperial unit toggle — drives display labels and converters everywhere
  // values are shown. Resolution order: ?units= URL param, then localStorage
  // (set by the cogwheel toggle on the main viewer), then locale-based
  // default for first visit. Keep this block in sync with app.js / inspector.js.
  const UNITS_STORAGE_KEY = "eucviewer-units";
  const IMPERIAL_REGIONS = ["US", "LR", "MM", "GB"];
  function detectUnits() {
    const force = new URLSearchParams(location.search).get("units");
    if (force === "imperial" || force === "metric") return force;
    try {
      const stored = localStorage.getItem(UNITS_STORAGE_KEY);
      if (stored === "imperial" || stored === "metric") return stored;
    } catch (_) {}
    try {
      const loc = new Intl.Locale(navigator.language || "en").maximize();
      if (IMPERIAL_REGIONS.includes(loc.region)) return "imperial";
    } catch (_) {}
    return "metric";
  }
  const UNITS = (() => {
    const imperial = detectUnits() === "imperial";
    return imperial
      ? {
          imperial: true,
          dist:  (km) => km * 0.621371,
          speed: (kmh) => kmh * 0.621371,
          temp:  (c) => c * 9 / 5 + 32,
          alt:   (m) => m * 3.28084,
          distUnit: "mi", speedUnit: "mph", tempUnit: "°F", altUnit: "ft",
        }
      : {
          imperial: false,
          dist:  (km) => km, speed: (kmh) => kmh, temp: (c) => c, alt: (m) => m,
          distUnit: "km", speedUnit: "km/h", tempUnit: "°C", altUnit: "m",
        };
  })();
  // Temperature *differences* scale by 9/5 but must not get the +32 offset.
  const tempDelta = (c) => (UNITS.imperial ? c * 9 / 5 : c);

  // ---------- DOM ----------
  const errorBanner = document.getElementById("error-banner");
  const subtitleEl = document.getElementById("page-subtitle");
  const groupSel = document.getElementById("group-select");
  const battMinSel = document.getElementById("batt-min-select");
  const minBinSel = document.getElementById("minbin-select");
  const rollingCheck = document.getElementById("rolling-check");
  const normalizeCheck = document.getElementById("normalize-check");
  const weatherBtn = document.getElementById("weather-btn");
  const weatherStatus = document.getElementById("weather-status");
  const progressStrip = document.getElementById("progress-strip");
  const progressFill = document.getElementById("progress-strip-fill");
  const insightsBox = document.getElementById("insights");
  const insightsList = document.getElementById("insights-list");
  const rangeTempHost = document.getElementById("range-temp-host");

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove("hidden");
  }

  // ---------- Tabs / layout ----------
  // Tab membership comes from data-tab attributes on sections. The active tab
  // gets a `.tab-active` class so CSS in [data-tab]:not(.tab-active) hides the
  // siblings in tabs mode. Single-page mode shows everything.
  const LAYOUT_KEY = "wheel-forensics-layout";
  let activeTab = "overview";
  function applyLayout(layout) {
    document.body.setAttribute("data-layout", layout);
    const btn = document.getElementById("layout-toggle");
    if (btn) btn.title = layout === "tabs" ? "Switch to one-page layout" : "Switch to tabbed layout";
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch (_) {}
    if (typeof renderAll === "function") renderAll();
  }
  function applyTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll("[data-tab]").forEach((el) => {
      if (el.classList.contains("tab-btn")) return;
      el.classList.toggle("tab-active", el.dataset.tab === tab);
    });
    if (typeof renderAll === "function") renderAll();
  }
  // `renderAll` is a function declaration further down — it's hoisted into
  // this scope already, so applyTab/applyLayout above can reference it.
  (function initLayoutControls() {
    let saved = "tabs";
    try { saved = localStorage.getItem(LAYOUT_KEY) || "tabs"; } catch (_) {}
    document.body.setAttribute("data-layout", saved);
    const btn = document.getElementById("layout-toggle");
    if (btn) {
      btn.title = saved === "tabs" ? "Switch to one-page layout" : "Switch to tabbed layout";
      btn.addEventListener("click", () => {
        const current = document.body.getAttribute("data-layout") || "tabs";
        applyLayout(current === "tabs" ? "single" : "tabs");
      });
    }
    document.querySelectorAll("[data-tab]").forEach((el) => {
      if (el.classList.contains("tab-btn")) return;
      el.classList.toggle("tab-active", el.dataset.tab === activeTab);
    });
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === activeTab);
      b.addEventListener("click", () => applyTab(b.dataset.tab));
    });
  })();

  // ---------- Load tracks (IndexedDB first — see CLAUDE.md) ----------
  const DB_NAME = "eucplanet-trip-viewer";
  const RECENT_STORE_NAME = "recentFiles";
  const SESSION_STORE_NAME = "currentSession";
  const WEATHER_STORE_NAME = "weatherCache";
  const SESSION_KEY = "tracks";

  // Same v3 schema as openRecentDb() in app.js — whichever page opens the DB
  // first creates the weatherCache store; the upgrade blocks must match.
  let dbPromise = null;
  function openDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 3);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(RECENT_STORE_NAME)) {
            db.createObjectStore(RECENT_STORE_NAME, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
            db.createObjectStore(SESSION_STORE_NAME);
          }
          if (!db.objectStoreNames.contains(WEATHER_STORE_NAME)) {
            db.createObjectStore(WEATHER_STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open database"));
      }).catch((e) => { dbPromise = null; throw e; });
    }
    return dbPromise;
  }

  async function loadFromIDB() {
    try {
      const db = await openDb();
      if (!db) return null;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction(SESSION_STORE_NAME, "readonly");
          const getReq = tx.objectStore(SESSION_STORE_NAME).get(SESSION_KEY);
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    } catch { return null; }
  }

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem("dbb_tracks") || sessionStorage.getItem("dbb_tracks");
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  }

  let tracks = await loadFromIDB();
  if (!tracks || !Array.isArray(tracks) || !tracks.length) {
    tracks = loadFromLocalStorage();
  }
  if (!tracks || !Array.isArray(tracks) || !tracks.length) {
    showError("No trips found. Open the main viewer, load your trips, then come back here.");
    return;
  }

  // Timeseries layout: [sec, speed, voltage, temp, battery, altitude, lat, lon, mileageKm,
  //                     pwm, current, power, gpsSpeed, gForce, gForceX, gForceY]
  const SEC = 0, SPD = 1, VOLT = 2, TEMP = 3, BATT = 4, LAT = 6, LON = 7, MILEAGE = 8;
  const CURRENT = 10, POWER = 11;

  // ---------- Small stats helpers ----------
  function median(values) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function percentile(values, p) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }
  // Median of `values` where each value carries a weight (we weight trips by
  // distance so one long ride counts more than five around-the-block hops).
  function weightedMedian(values, weights) {
    if (!values.length) return null;
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return median(values);
    let acc = 0;
    for (const i of order) {
      acc += weights[i];
      if (acc >= total / 2) return values[i];
    }
    return values[order[order.length - 1]];
  }
  // Theil–Sen robust regression: slope = median of pairwise slopes. Resistant
  // to outliers, no library needed. Caps the sample so n² stays bounded.
  function theilSen(xs, ys) {
    let n = xs.length;
    if (n < 8) return null;
    let ix = xs.map((_, i) => i);
    if (n > 400) {
      for (let i = ix.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ix[i], ix[j]] = [ix[j], ix[i]];
      }
      ix = ix.slice(0, 400);
      n = 400;
    }
    const slopes = [];
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const dx = xs[ix[b]] - xs[ix[a]];
        if (dx === 0) continue;
        slopes.push((ys[ix[b]] - ys[ix[a]]) / dx);
      }
    }
    const slope = median(slopes);
    if (slope == null) return null;
    const intercept = median(ix.map((i) => ys[i] - slope * xs[i]));
    return { slope, intercept };
  }
  // Ordinary least-squares slope (used per trip for the V~I sag fit, where
  // n is small and the samples are already filtered).
  function lsSlope(xs, ys) {
    const n = xs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += xs[i]; sy += ys[i];
      sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    return (n * sxy - sx * sy) / denom;
  }

  // ---------- Per-trip metric extraction ----------
  function parseTripDate(t) {
    const ds = t.dateStart || "";
    if (ds) {
      const d = new Date(ds);
      if (!isNaN(d.getTime())) return d;
    }
    if (t.date) {
      // "DD.MM.YYYY" filename-derived date — same fallback app.js sorting uses.
      const parts = t.date.split(".");
      if (parts.length === 3) {
        const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        if (!isNaN(d.getTime())) return d;
      }
    }
    return null;
  }

  function tripDistanceKm(t) {
    if (t.stats && t.stats.distanceKm > 0) return t.stats.distanceKm;
    const ts = t.timeseries;
    if (!Array.isArray(ts) || ts.length < 2) return 0;
    // Mileage odometer column if present, else integrate speed over time —
    // the same fallbacks loadTracks() in app.js applies for legacy tracks.
    if (ts[0].length > MILEAGE) {
      let last = 0;
      for (let i = 0; i < ts.length; i++) { const mi = ts[i][MILEAGE] || 0; if (mi > last) last = mi; }
      if (last > 0) return Math.round(last * 100) / 100;
    }
    let running = 0;
    for (let i = 1; i < ts.length; i++) {
      const dtSec = Math.max(0, ts[i][SEC] - ts[i - 1][SEC]);
      const avgSpd = ((ts[i][SPD] || 0) + (ts[i - 1][SPD] || 0)) / 2;
      running += (avgSpd * dtSec) / 3600;
    }
    return Math.round(running * 100) / 100;
  }

  // Some EUC loggers keep writing samples after the wheel powers off — the
  // voltage column snaps to a constant low value (e.g. 13.1 V) and the
  // battery % freezes at whatever it last saw, while real samples sit safely
  // above 60 V for any pack still in use. Find the last "alive" index so
  // every downstream computation (battery delta, IR fit, temp max, etc.)
  // skips that junk tail. Threshold of 50 V is below any modern EUC pack
  // (lowest is 67 V at 0% for InMotion V8) yet well above the typical
  // corrupted-tail readings (10–20 V).
  function lastAliveIndex(ts) {
    for (let i = ts.length - 1; i >= 0; i--) {
      const v = ts[i][VOLT];
      if (typeof v === "number" && v >= 50) return i;
    }
    return -1;
  }

  function computeTripMetrics(t) {
    const rawTs = Array.isArray(t.timeseries) ? t.timeseries : [];
    const lastAlive = lastAliveIndex(rawTs);
    const ts = lastAlive >= 0 ? rawTs.slice(0, lastAlive + 1) : rawTs;
    const date = parseTripDate(t);
    const m = {
      date,
      dateStr: date ? localDateStr(date) : null,
      label: t.date || t.name || "Trip",
      distKm: tripDistanceKm(t),
      durH: 0,
      battStart: null, battEnd: null, battDelta: null,
      kmPerPct: null,
      energyWh: null, whPerKm: null,
      avgMovingSpeed: null, avgCurrent: null, avgPower: null,
      ohmIR: null,
      tempMax: null, tempStart: null,
      ambientC: null,
      centroid: null,
    };
    if (t.dateStart && t.dateEnd) {
      const s = new Date(t.dateStart).getTime();
      const e = new Date(t.dateEnd).getTime();
      if (s && e && e > s) m.durH = (e - s) / 3600000;
    }
    if (!m.durH && ts.length > 1) {
      m.durH = Math.max(0, (ts[ts.length - 1][SEC] - ts[0][SEC]) / 3600);
    }
    if (ts.length < 2) return m;

    // Battery start/end: median of the first/last 10 alive-tail samples.
    // Robust against load-sag dips and against logger-tail corruption.
    const battSamples = [];
    for (const row of ts) {
      const v = row[BATT];
      if (typeof v === "number" && v > 0) battSamples.push(v);
    }
    if (battSamples.length >= 4) {
      m.battStart = median(battSamples.slice(0, 10));
      m.battEnd = median(battSamples.slice(-10));
      m.battDelta = m.battStart - m.battEnd;
    }

    // Energy: prefer the logged power column, else reconstruct V×I.
    let hasPower = false, hasVolt = false, hasCurrent = false;
    for (const row of ts) {
      if ((row[POWER] || 0) !== 0) hasPower = true;
      if ((row[VOLT] || 0) !== 0) hasVolt = true;
      if ((row[CURRENT] || 0) !== 0) hasCurrent = true;
    }
    if (hasPower || (hasVolt && hasCurrent)) {
      let wh = 0;
      for (let i = 1; i < ts.length; i++) {
        const dtSec = Math.max(0, ts[i][SEC] - ts[i - 1][SEC]);
        if (dtSec === 0 || dtSec > 300) continue; // gap in the log — skip
        const pNow = hasPower ? (ts[i][POWER] || 0) : (ts[i][VOLT] || 0) * (ts[i][CURRENT] || 0);
        const pPrev = hasPower ? (ts[i - 1][POWER] || 0) : (ts[i - 1][VOLT] || 0) * (ts[i - 1][CURRENT] || 0);
        wh += ((pNow + pPrev) / 2) * dtSec / 3600;
      }
      if (wh > 0) {
        m.energyWh = wh;
        if (m.distKm >= 1) m.whPerKm = wh / m.distKm;
      }
    }

    // Averages over "moving" samples.
    let spdSum = 0, spdCnt = 0, curSum = 0, curCnt = 0, powSum = 0, powCnt = 0;
    for (const row of ts) {
      const s = row[SPD] || 0;
      if (s > 2) { spdSum += s; spdCnt++; }
      const c = row[CURRENT] || 0;
      if (c > 0) { curSum += c; curCnt++; }
      const p = row[POWER] || 0;
      if (p > 0) { powSum += p; powCnt++; }
    }
    if (spdCnt >= 10) m.avgMovingSpeed = spdSum / spdCnt;
    if (curCnt >= 10) m.avgCurrent = curSum / curCnt;
    if (powCnt >= 10) m.avgPower = powSum / powCnt;

    // Internal-resistance proxy via the delta method: regress dV vs dI over
    // short timesteps so SoC drift across the trip cancels out (each pair only
    // spans ~1-2 seconds). Only sample pairs with a meaningful load step
    // contribute — small noise around steady cruising adds variance without
    // information. -slope is the effective IR (positive = ohms).
    if (hasVolt && hasCurrent) {
      const dXs = [], dYs = [];
      for (let i = 1; i < ts.length; i++) {
        const dt = ts[i][SEC] - ts[i - 1][SEC];
        if (dt <= 0 || dt > 3) continue;
        const v0 = ts[i - 1][VOLT] || 0, v1 = ts[i][VOLT] || 0;
        const c0 = ts[i - 1][CURRENT] || 0, c1 = ts[i][CURRENT] || 0;
        if (v0 < 10 || v1 < 10) continue;
        const dI = c1 - c0;
        if (Math.abs(dI) < 2) continue;
        dXs.push(dI);
        dYs.push(v1 - v0);
      }
      if (dXs.length >= 30) {
        const slope = lsSlope(dXs, dYs);
        // Real EUC pack IR seen at the wheel is typically 30–150 mΩ.
        // Anything > 0.2 Ω means the fit is dominated by something other
        // than true load response (noise, gear changes, etc).
        if (slope != null && slope < 0 && -slope < 0.2) m.ohmIR = -slope;
      }
    }

    // Temperatures.
    const temps = [];
    for (const row of ts) {
      const v = row[TEMP];
      if (typeof v === "number" && v !== 0) temps.push(v);
    }
    if (temps.length >= 4) {
      m.tempMax = Math.max(...temps);
      m.tempStart = median(temps.slice(0, 5));
    }

    // GPS centroid rounded to 0.1° (~11 km) — coarse on purpose, both for
    // weather-cache hits and so precise locations never leave the browser.
    let latSum = 0, lonSum = 0, gpsCnt = 0;
    for (const row of ts) {
      const lat = row[LAT] || 0, lon = row[LON] || 0;
      if (lat !== 0 || lon !== 0) { latSum += lat; lonSum += lon; gpsCnt++; }
    }
    if (gpsCnt >= 3) {
      m.centroid = [Math.round((latSum / gpsCnt) * 10) / 10, Math.round((lonSum / gpsCnt) * 10) / 10];
    }
    return m;
  }

  function localDateStr(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // Gated derivations that depend on the "min battery use" control.
  function applyRangeGating(m, minBattUse) {
    if (m.battDelta != null && m.battDelta >= minBattUse && m.distKm >= 2) {
      m.kmPerPct = m.distKm / m.battDelta;
      m.estRangeKm = m.kmPerPct * 100;
    } else {
      m.kmPerPct = null;
      m.estRangeKm = null;
    }
  }

  // ---------- Compute all metrics (chunked so the UI paints) ----------
  progressStrip.classList.remove("hidden");
  const tripMetrics = [];
  for (let i = 0; i < tracks.length; i++) {
    tripMetrics.push(computeTripMetrics(tracks[i]));
    if (i % 200 === 199) {
      progressFill.style.width = Math.round((i / tracks.length) * 100) + "%";
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  progressStrip.classList.add("hidden");

  // Analysis works oldest → newest; undated trips can't be placed on a
  // timeline, so they're dropped (counted in the subtitle).
  const dated = tripMetrics.filter((m) => m.date).sort((a, b) => a.date - b.date);
  const undatedCount = tripMetrics.length - dated.length;
  if (!dated.length) {
    showError("None of the loaded trips carry a date, so a history timeline can't be built.");
    return;
  }
  // Epoch position 0..1 for the old→new colour ramp on scatter charts.
  dated.forEach((m, i) => { m.epoch = dated.length > 1 ? i / (dated.length - 1) : 0.5; });

  {
    let totalKm = 0;
    for (const m of dated) totalKm += m.distKm;
    const fmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
    let sub = `${dated.length} trips · ${UNITS.dist(totalKm).toFixed(0)} ${UNITS.distUnit} · ` +
              `${fmt.format(dated[0].date)} – ${fmt.format(dated[dated.length - 1].date)}`;
    if (undatedCount) sub += ` · ${undatedCount} undated skipped`;
    subtitleEl.textContent = sub;
  }

  // ---------- Binning ----------
  const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
  const WEEK_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "2-digit" });
  // Monday-anchored week start; ISO style so a Sunday ride doesn't span two
  // years of labels when it sits on the Dec/Jan boundary.
  function weekStart(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (x.getDay() + 6) % 7; // Mon=0, Sun=6
    x.setDate(x.getDate() - day);
    return x;
  }
  function weekKey(d) {
    const ws = weekStart(d);
    return ws.getFullYear() + "-W" + String(ws.getMonth()).padStart(2, "0") + "-" + String(ws.getDate()).padStart(2, "0");
  }
  function weekLabel(d) {
    return WEEK_FMT.format(weekStart(d));
  }
  function binKeyAndLabel(mode, d) {
    const y = d.getFullYear(), mo = d.getMonth();
    if (mode === "week") return { key: weekKey(d), label: weekLabel(d) };
    if (mode === "month") return { key: y + "-" + String(mo).padStart(2, "0"), label: MONTH_FMT.format(d) };
    if (mode === "quarter") { const q = Math.floor(mo / 3) + 1; return { key: y + "-Q" + q, label: "Q" + q + " '" + String(y).slice(2) }; }
    return { key: String(y), label: String(y) };
  }
  function nextCalendarKey(mode, key) {
    if (mode === "week") {
      const [y, mPart, dPart] = key.split("-W").join("-").split("-");
      const d = new Date(Number(y), Number(mPart), Number(dPart) + 7);
      return weekKey(d);
    }
    if (mode === "month") {
      let [y, m] = key.split("-").map(Number);
      m++; if (m > 11) { m = 0; y++; }
      return y + "-" + String(m).padStart(2, "0");
    }
    if (mode === "quarter") {
      let [y, q] = key.split("-Q").map(Number);
      q++; if (q > 4) { q = 1; y++; }
      return y + "-Q" + q;
    }
    return String(Number(key) + 1);
  }
  function calendarKeyToLabel(mode, key) {
    if (mode === "week") {
      const [y, mPart, dPart] = key.split("-W").join("-").split("-");
      return WEEK_FMT.format(new Date(Number(y), Number(mPart), Number(dPart)));
    }
    if (mode === "month") {
      const [y, m] = key.split("-").map(Number);
      return MONTH_FMT.format(new Date(y, m, 1));
    }
    if (mode === "quarter") {
      const [y, q] = key.split("-Q");
      return "Q" + q + " '" + String(y).slice(2);
    }
    return key;
  }

  function makeBins(metrics, mode) {
    const bins = [];
    if (mode === "week" || mode === "month" || mode === "quarter" || mode === "year") {
      const map = new Map();
      for (const m of metrics) {
        const { key, label } = binKeyAndLabel(mode, m.date);
        if (!map.has(key)) map.set(key, { key, label, trips: [] });
        map.get(key).trips.push(m);
      }
      // Contiguous calendar axis: empty periods stay visible as gaps so a
      // winter pause doesn't get visually stitched out of the trend.
      const keys = [...map.keys()].sort();
      let key = keys[0];
      const last = keys[keys.length - 1];
      let guard = 0;
      while (guard++ < 1000) {
        bins.push(map.get(key) || { key, label: calendarKeyToLabel(mode, key), trips: [] });
        if (key === last) break;
        key = nextCalendarKey(mode, key);
      }
      return bins;
    }
    // Cumulative odometer / riding-hours bins, oldest → newest.
    const byKm = mode.startsWith("km");
    const size = Number(mode.replace(/^(km|h)/, ""));
    let acc = 0, edge = size, cur = { key: "0", label: "", trips: [], from: 0 };
    const unitTotal = (m) => (byKm ? m.distKm : m.durH);
    for (const m of metrics) {
      cur.trips.push(m);
      acc += unitTotal(m);
      if (acc >= edge) {
        cur.to = acc;
        bins.push(cur);
        cur = { key: String(bins.length), label: "", trips: [], from: acc };
        while (edge <= acc) edge += size;
      }
    }
    if (cur.trips.length) { cur.to = acc; bins.push(cur); }
    for (const b of bins) {
      const from = byKm ? UNITS.dist(b.from) : b.from;
      const to = byKm ? UNITS.dist(b.to) : b.to;
      b.label = Math.round(from) + "–" + Math.round(to) + (byKm ? " " + UNITS.distUnit : " h");
    }
    return bins;
  }

  // Per-bin robust summary of one metric: distance-weighted median + IQR.
  // `minN` drops bins that don't have enough samples to be trustworthy — single
  // unusual trips otherwise create huge whipsaw spikes in the trend.
  function binStats(bins, getter, minN) {
    if (minN == null) minN = 1;
    return bins.map((b) => {
      const vals = [], weights = [];
      for (const m of b.trips) {
        const v = getter(m);
        if (v != null && isFinite(v)) { vals.push(v); weights.push(Math.max(0.1, m.distKm)); }
      }
      if (vals.length < minN) return null;
      return {
        med: weightedMedian(vals, weights),
        p25: percentile(vals, 0.25),
        p75: percentile(vals, 0.75),
        n: vals.length,
      };
    });
  }
  function rollingMedians(stats, win) {
    const half = Math.floor(win / 2);
    return stats.map((_, i) => {
      const window = [];
      for (let j = i - half; j <= i + half; j++) {
        if (stats[j] && stats[j].med != null) window.push(stats[j].med);
      }
      return window.length ? window.reduce((a, b) => a + b, 0) / window.length : null;
    });
  }

  // ---------- Weather (Open-Meteo archive, free, no key) ----------
  async function readWeatherCache(key) {
    try {
      const db = await openDb();
      if (!db) return null;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction(WEATHER_STORE_NAME, "readonly");
          const req = tx.objectStore(WEATHER_STORE_NAME).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    } catch { return null; }
  }
  async function writeWeatherCache(key, value) {
    try {
      const db = await openDb();
      if (!db) return;
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(WEATHER_STORE_NAME, "readwrite");
          tx.objectStore(WEATHER_STORE_NAME).put(value, key);
          tx.oncomplete = resolve;
          tx.onabort = resolve;
          tx.onerror = resolve;
        } catch { resolve(); }
      });
    } catch {}
  }

  let weatherLoaded = false;

  function weatherClusters() {
    // One cluster per rounded 0.1° centroid; a single archive request spans
    // that cluster's whole date range at daily resolution.
    const map = new Map();
    for (const m of dated) {
      if (!m.centroid || !m.dateStr) continue;
      const key = m.centroid[0] + "|" + m.centroid[1];
      if (!map.has(key)) map.set(key, { key, lat: m.centroid[0], lon: m.centroid[1], dates: new Set(), trips: [] });
      const c = map.get(key);
      c.dates.add(m.dateStr);
      c.trips.push(m);
    }
    return [...map.values()];
  }

  async function fetchWeather() {
    const clusters = weatherClusters();
    if (!clusters.length) {
      weatherStatus.textContent = "No GPS data in these trips.";
      weatherStatus.className = "error";
      return;
    }
    weatherBtn.disabled = true;
    weatherStatus.className = "";
    let done = 0, failed = 0;
    for (const c of clusters) {
      weatherStatus.textContent = `Fetching ${++done}/${clusters.length}…`;
      const cached = (await readWeatherCache(c.key)) || { days: {} };
      const missing = [...c.dates].filter((d) => !(d in cached.days));
      if (missing.length) {
        missing.sort();
        // The ERA5 archive lags ~5 days; clamp so the request never 400s.
        const maxDate = localDateStr(new Date(Date.now() - 6 * 86400000));
        const start = missing[0];
        const end = missing[missing.length - 1] < maxDate ? missing[missing.length - 1] : maxDate;
        if (start <= end) {
          try {
            const url = "https://archive-api.open-meteo.com/v1/archive" +
              `?latitude=${c.lat}&longitude=${c.lon}` +
              `&start_date=${start}&end_date=${end}` +
              "&daily=temperature_2m_mean,temperature_2m_max&timezone=auto";
            const resp = await fetch(url);
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();
            const times = (data.daily && data.daily.time) || [];
            const means = (data.daily && data.daily.temperature_2m_mean) || [];
            const maxes = (data.daily && data.daily.temperature_2m_max) || [];
            for (let i = 0; i < times.length; i++) {
              if (means[i] != null) cached.days[times[i]] = { mean: means[i], max: maxes[i] != null ? maxes[i] : means[i] };
            }
            cached.fetchedAt = new Date().toISOString();
            await writeWeatherCache(c.key, cached);
          } catch (e) {
            failed++;
          }
        }
      }
      for (const m of c.trips) {
        const day = cached.days[m.dateStr];
        if (day) m.ambientC = day.mean;
      }
    }
    const withAmbient = dated.filter((m) => m.ambientC != null).length;
    if (withAmbient) {
      weatherLoaded = true;
      weatherStatus.textContent = `Ambient temp for ${withAmbient} of ${dated.length} trips` + (failed ? ` (${failed} location${failed > 1 ? "s" : ""} failed)` : "");
      weatherStatus.className = failed ? "error" : "ok";
      weatherBtn.textContent = "Weather added";
    } else {
      weatherStatus.textContent = "Weather fetch failed. Check your connection.";
      weatherStatus.className = "error";
      weatherBtn.disabled = false;
    }
    renderAll();
  }
  weatherBtn.addEventListener("click", fetchWeather);

  // ---------- Chart drawing ----------
  const COLORS = {
    range: "#69f0ae",
    rangeNorm: "#fff176",
    whPerKm: "#7c4dff",
    kmPerPct: "#00e5ff",
    ampsPerKmh: "#ffd740",
    tempRise: "#ffa000",
    ohmIR: "#ff5252",
    rolling: "#ffffff",
  };
  const AXIS_COLOR = "rgba(255,255,255,0.35)";
  const GRID_COLOR = "rgba(255,255,255,0.06)";
  const FONT = "10px -apple-system, sans-serif";

  const tooltip = document.createElement("div");
  tooltip.id = "an-tooltip";
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);
  function showTooltip(html, x, y) {
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
    const w = tooltip.offsetWidth, h = tooltip.offsetHeight, m = 8;
    let left = x + 14, top = y - 10;
    if (left + w + m > window.innerWidth) left = x - w - 14;
    if (top + h + m > window.innerHeight) top = window.innerHeight - h - m;
    if (top < m) top = m;
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }
  function hideTooltip() { tooltip.style.display = "none"; }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    return { ctx, w: rect.width, h: rect.height };
  }

  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    let step = mag;
    for (const k of [1, 2, 2.5, 5, 10]) {
      if (mag * k >= step0) { step = mag * k; break; }
    }
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(v);
    return ticks;
  }

  function fmtVal(v, dp) {
    if (v == null || !isFinite(v)) return "—";
    if (dp != null) return v.toFixed(dp);
    const a = Math.abs(v);
    return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2);
  }

  // Trend chart over bins: each series is {stats, color, label, unit, band}.
  // `rolling` adds a white moving-average overlay per series.
  function drawTrendChart(canvas, bins, series, opts = {}) {
    const cv = setupCanvas(canvas);
    if (!cv) return;
    const { ctx, w, h } = cv;
    const pad = { top: 12, bottom: 22, left: 44, right: series.length > 1 ? 44 : 14 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const n = bins.length;
    const xAt = (i) => pad.left + (n > 1 ? (i / (n - 1)) * cw : cw / 2);

    // Each series gets its own y-scale (left axis = first, right = second).
    const scales = series.map((s) => {
      let min = Infinity, max = -Infinity;
      for (const st of s.stats) {
        if (!st) continue;
        const lo = s.band && st.p25 != null ? st.p25 : st.med;
        const hi = s.band && st.p75 != null ? st.p75 : st.med;
        if (lo < min) min = lo;
        if (hi > max) max = hi;
      }
      if (s.extra) {
        for (const v of s.extra) {
          if (v == null) continue;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!isFinite(min)) return null;
      const span = max - min || Math.abs(max) || 1;
      min -= span * 0.12; max += span * 0.12;
      if (opts.zeroBase && min > 0) min = 0;
      return { min, max };
    });

    ctx.font = FONT;
    // Grid + left axis labels off the first series' scale.
    const s0 = scales.find((s) => s);
    if (s0) {
      const ticks = niceTicks(s0.min, s0.max, 4);
      ctx.fillStyle = AXIS_COLOR;
      ctx.strokeStyle = GRID_COLOR;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const i0 = scales.indexOf(s0);
      for (const tv of ticks) {
        const y = pad.top + ch - ((tv - s0.min) / (s0.max - s0.min)) * ch;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
        ctx.fillStyle = series[i0].color;
        ctx.fillText(fmtVal(tv), pad.left - 6, y);
      }
      // Right axis for a second scaled series.
      if (scales.length > 1 && scales[1] && scales[1] !== s0) {
        const t2 = niceTicks(scales[1].min, scales[1].max, 4);
        ctx.textAlign = "left";
        ctx.fillStyle = series[1].color;
        for (const tv of t2) {
          const y = pad.top + ch - ((tv - scales[1].min) / (scales[1].max - scales[1].min)) * ch;
          ctx.fillText(fmtVal(tv), w - pad.right + 6, y);
        }
      }
    }

    // X labels — thin to at most ~8.
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelStep = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += labelStep) {
      ctx.fillText(bins[i].label, xAt(i), pad.top + ch + 6);
    }

    series.forEach((s, si) => {
      const sc = scales[si];
      if (!sc) return;
      const yAt = (v) => pad.top + ch - ((v - sc.min) / (sc.max - sc.min)) * ch;

      // IQR band.
      if (s.band) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const st = s.stats[i];
          if (!st || st.p25 == null) { started = false; continue; }
          const x = xAt(i), y = yAt(st.p75);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        for (let i = n - 1; i >= 0; i--) {
          const st = s.stats[i];
          if (!st || st.p25 == null) continue;
          ctx.lineTo(xAt(i), yAt(st.p25));
        }
        ctx.closePath();
        ctx.fillStyle = s.color + "22";
        ctx.fill();
      }

      // Median line (broken across empty bins) + dots.
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const st = s.stats[i];
        if (!st || st.med == null) { started = false; continue; }
        const x = xAt(i), y = yAt(st.med);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = s.color;
      for (let i = 0; i < n; i++) {
        const st = s.stats[i];
        if (!st || st.med == null) continue;
        ctx.beginPath();
        ctx.arc(xAt(i), yAt(st.med), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (opts.rolling) {
        const roll = rollingMedians(s.stats, 3);
        ctx.strokeStyle = COLORS.rolling;
        ctx.globalAlpha = 0.65;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        started = false;
        for (let i = 0; i < n; i++) {
          if (roll[i] == null) { started = false; continue; }
          const x = xAt(i), y = yAt(roll[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    });

    // Legend.
    ctx.textBaseline = "alphabetic";
    let lx = pad.left + 4;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, 6, 8, 3);
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.textAlign = "left";
      ctx.fillText(s.label, lx + 12, 11);
      lx += 12 + ctx.measureText(s.label).width + 16;
    }

    canvas._an = { type: "trend", bins, series, pad, cw, ch, w, h, xAt };
  }

  // Scatter: points {x, y, epoch, meta}; old→new colour ramp.
  function epochColor(t) {
    const r = Math.round(70 + (255 - 70) * t);
    const g = Math.round(130 + (90 - 130) * t);
    const b = Math.round(255 + (70 - 255) * t);
    return `rgb(${r},${g},${b})`;
  }
  function drawScatter(canvas, pts, opts) {
    const cv = setupCanvas(canvas);
    if (!cv) return;
    const { ctx, w, h } = cv;
    const pad = { top: 14, bottom: 26, left: 44, right: 14 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of pts) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    const xSpan = (xMax - xMin) || 1, ySpan = (yMax - yMin) || 1;
    xMin -= xSpan * 0.06; xMax += xSpan * 0.06;
    yMin -= ySpan * 0.1; yMax += ySpan * 0.1;
    const xAt = (v) => pad.left + ((v - xMin) / (xMax - xMin)) * cw;
    const yAt = (v) => pad.top + ch - ((v - yMin) / (yMax - yMin)) * ch;
    // Expose the transform so other code can overlay fit lines / annotations.
    canvas._scatterMap = { xAt, yAt, xMin, xMax, yMin, yMax };

    ctx.font = FONT;
    ctx.strokeStyle = GRID_COLOR;
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const tv of niceTicks(yMin, yMax, 4)) {
      const y = yAt(tv);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillText(fmtVal(tv), pad.left - 6, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // The x-axis title sits on the same line at the right edge — skip tick
    // labels that would collide with it.
    const xTitleW = ctx.measureText(opts.xLabel).width;
    for (const tv of niceTicks(xMin, xMax, 6)) {
      const x = xAt(tv);
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ch); ctx.stroke();
      if (x < w - pad.right - xTitleW - 16) ctx.fillText(fmtVal(tv), x, pad.top + ch + 6);
    }
    // Axis titles.
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.textAlign = "left";
    ctx.fillText(opts.yLabel, pad.left + 4, 2);
    ctx.textAlign = "right";
    ctx.fillText(opts.xLabel, w - pad.right, pad.top + ch + 6);

    const drawn = [];
    for (const p of pts) {
      const x = xAt(p.x), y = yAt(p.y);
      ctx.fillStyle = epochColor(p.epoch);
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      drawn.push({ x, y, p });
    }
    ctx.globalAlpha = 1;

    // Old→new ramp legend.
    const lw = 60, lx = w - pad.right - lw - 4, ly = 6;
    for (let i = 0; i < lw; i++) {
      ctx.fillStyle = epochColor(i / lw);
      ctx.fillRect(lx + i, ly, 1, 4);
    }
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("old", lx - 4, ly + 2);
    ctx.textAlign = "left";
    ctx.fillText("new", lx + lw + 4, ly + 2);

    canvas._an = { type: "scatter", drawn, opts };
  }

  // Ensure every chart-host gets a single crosshair overlay element.
  function ensureCrosshair(host) {
    let ch = host.querySelector(".chart-crosshair");
    if (!ch) {
      ch = document.createElement("div");
      ch.className = "chart-crosshair";
      host.appendChild(ch);
    }
    return ch;
  }
  function hideAllCrosshairs() {
    document.querySelectorAll(".chart-crosshair").forEach((el) => (el.style.display = "none"));
  }
  // Position the crosshair on every trend chart at the given bin index, so
  // the user can read across all time-series at once.
  function syncCrosshair(binIdx) {
    document.querySelectorAll("canvas").forEach((cv) => {
      const an = cv._an;
      if (!an || an.type !== "trend") return;
      const host = cv.parentElement;
      if (!host) return;
      const ch = ensureCrosshair(host);
      if (binIdx == null || binIdx < 0 || binIdx >= an.bins.length) { ch.style.display = "none"; return; }
      // an.xAt is in CSS pixels relative to the canvas, and canvas fills
      // the host, so the chart-host-relative x is the same value.
      const x = an.xAt(binIdx);
      ch.style.display = "block";
      ch.style.left = Math.round(x) + "px";
    });
  }

  // One delegated hover handler for all charts.
  document.addEventListener("mousemove", (e) => {
    const canvas = e.target.closest && e.target.closest("canvas");
    if (!canvas || !canvas._an) { hideTooltip(); hideAllCrosshairs(); return; }
    const an = canvas._an;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (an.type === "trend") {
      const n = an.bins.length;
      let best = -1, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(an.xAt(i) - mx);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0 || bestD > 40) { hideTooltip(); hideAllCrosshairs(); return; }
      syncCrosshair(best);
      const bin = an.bins[best];
      let html = `<b>${bin.label}</b> · ${bin.trips.length} trip${bin.trips.length === 1 ? "" : "s"}`;
      for (const s of an.series) {
        const st = s.stats[best];
        if (!st || st.med == null) continue;
        html += `<br>${s.label}: <b>${fmtVal(st.med, s.dp)}</b> ${s.unit || ""}`;
        if (s.band && st.p25 != null) html += ` <span style="color:#888">(${fmtVal(st.p25, s.dp)}–${fmtVal(st.p75, s.dp)})</span>`;
      }
      showTooltip(html, e.clientX, e.clientY);
    } else {
      hideAllCrosshairs();
      let best = null, bestD = Infinity;
      for (const d of an.drawn) {
        const dx = d.x - mx, dy = d.y - my;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) { bestD = dist; best = d; }
      }
      if (!best || bestD > 18 * 18) { hideTooltip(); return; }
      showTooltip(best.p.meta, e.clientX, e.clientY);
    }
  });
  document.addEventListener("mouseleave", () => { hideTooltip(); hideAllCrosshairs(); }, true);

  // ---------- Sections ----------
  function sectionEl(name) { return document.querySelector(`.chart-section[data-section="${name}"]`); }
  function setSectionEmpty(name, msg) {
    const sec = sectionEl(name);
    sec.classList.add("no-data");
    let note = sec.querySelector(".no-data-msg");
    if (!note) {
      note = document.createElement("div");
      note.className = "no-data-msg";
      sec.querySelector("h2").after(note);
    }
    note.textContent = msg;
  }
  function setSectionActive(name) {
    const sec = sectionEl(name);
    sec.classList.remove("no-data");
    const note = sec.querySelector(".no-data-msg");
    if (note) note.remove();
  }

  // Theil–Sen range-vs-ambient fit, recomputed whenever weather lands.
  let tempFit = null;
  function computeTempFit() {
    const xs = [], ys = [];
    for (const m of dated) {
      if (m.estRangeKm != null && m.ambientC != null) { xs.push(m.ambientC); ys.push(m.estRangeKm); }
    }
    tempFit = xs.length >= 10 ? theilSen(xs, ys) : null;
    normalizeCheck.disabled = !tempFit;
    if (!tempFit) normalizeCheck.checked = false;
  }

  function normalizedRange(m) {
    if (m.estRangeKm == null) return null;
    if (!normalizeCheck.checked || !tempFit || m.ambientC == null) return m.estRangeKm;
    return m.estRangeKm + tempFit.slope * (20 - m.ambientC);
  }

  // ---------- Lifetime / insights / activity ----------
  function fmtCompact(v, unit) {
    if (v == null || !isFinite(v)) return { v: "—", u: unit };
    const a = Math.abs(v);
    if (a >= 1000) return { v: (v / 1000).toFixed(a >= 10000 ? 1 : 2) + "k", u: unit };
    if (a >= 100) return { v: v.toFixed(0), u: unit };
    if (a >= 10) return { v: v.toFixed(1), u: unit };
    return { v: v.toFixed(1), u: unit };
  }
  function setStat(id, value, unit) {
    const el = document.getElementById(id);
    if (!el) return;
    if (value == null || !isFinite(value)) { el.textContent = "—"; return; }
    const f = fmtCompact(value, unit);
    el.innerHTML = `${f.v}<small>${unit ? " " + unit : ""}</small>`;
  }

  function renderLifetime() {
    let totalKm = 0, totalH = 0, totalWh = 0;
    let topSpd = 0, maxRangeKm = 0;
    const days = new Set();
    for (const m of dated) {
      totalKm += m.distKm;
      totalH += m.durH || 0;
      if (m.energyWh) totalWh += m.energyWh;
      if (m.dateStr) days.add(m.dateStr);
      if (m.estRangeKm != null && m.estRangeKm > maxRangeKm) maxRangeKm = m.estRangeKm;
    }
    // Top speed: pull from each track's stats since timeseries is downsampled.
    for (const t of tracks) {
      const v = t.stats && t.stats.maxSpeed;
      if (typeof v === "number" && v > topSpd) topSpd = v;
    }
    setStat("lf-trips", dated.length, "");
    setStat("lf-dist", UNITS.dist(totalKm), UNITS.distUnit);
    setStat("lf-hours", totalH, "h");
    setStat("lf-energy", totalWh / 1000, "kWh");
    setStat("lf-topspd", UNITS.speed(topSpd), UNITS.speedUnit);
    setStat("lf-maxrange", maxRangeKm ? UNITS.dist(maxRangeKm) : null, UNITS.distUnit);
    setStat("lf-days", days.size, "");
    // Average rides/month over the active span.
    const spanMs = dated[dated.length - 1].date - dated[0].date;
    const spanMonths = Math.max(1, spanMs / (1000 * 60 * 60 * 24 * 30.44));
    setStat("lf-cadence", dated.length / spanMonths, "");
  }

  // Insight generation. Compares the first vs last third of dated trips so a
  // single noisy bin can't dominate the headline. Each item is { kind, html }.
  function computeInsights() {
    const out = [];
    if (dated.length < 6) return out;
    const third = Math.max(2, Math.floor(dated.length / 3));
    const early = dated.slice(0, third);
    const late = dated.slice(-third);

    function pick(arr, getter, w) {
      const vs = [], ws = [];
      for (const m of arr) {
        const v = getter(m);
        if (v != null && isFinite(v)) { vs.push(v); ws.push(w ? Math.max(0.1, w(m)) : 1); }
      }
      if (!vs.length) return null;
      return weightedMedian(vs, ws);
    }
    const fmtPct = (a, b) => ((b - a) / a) * 100;

    // Range drift, ideally on temp-normalized values so a winter/summer mix
    // doesn't masquerade as battery health.
    const useNorm = !!tempFit;
    const rangeGetter = (m) => {
      if (m.estRangeKm == null) return null;
      if (useNorm && m.ambientC != null) return m.estRangeKm + tempFit.slope * (20 - m.ambientC);
      return m.estRangeKm;
    };
    const r0 = pick(early, rangeGetter, (m) => m.distKm);
    const r1 = pick(late, rangeGetter, (m) => m.distKm);
    if (r0 && r1) {
      const pct = fmtPct(r0, r1);
      const dispA = UNITS.dist(r0), dispB = UNITS.dist(r1);
      out.push({
        kind: pct < -5 ? "warn" : pct > 5 ? "good" : "info",
        html: `Estimated range ${pct >= 0 ? "up" : "down"} <b>${Math.abs(pct).toFixed(0)}%</b> ` +
              `(<b>${dispA.toFixed(1)}</b> to <b>${dispB.toFixed(1)}</b> ${UNITS.distUnit})` +
              (useNorm ? ", normalized to 20 °C." : ". Add weather to factor out temperature."),
      });
    }

    // Internal resistance drift.
    const ir0 = pick(early, (m) => m.ohmIR);
    const ir1 = pick(late, (m) => m.ohmIR);
    if (ir0 && ir1) {
      const pct = fmtPct(ir0, ir1);
      out.push({
        kind: pct > 15 ? "warn" : pct < -10 ? "good" : "info",
        html: `Internal resistance ${pct >= 0 ? "rose" : "fell"} from <b>${(ir0 * 1000).toFixed(0)}</b> mΩ to ` +
              `<b>${(ir1 * 1000).toFixed(0)}</b> mΩ (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%).`,
      });
    }

    // Efficiency drift (Wh/km).
    const e0 = pick(early, (m) => m.whPerKm, (m) => m.distKm);
    const e1 = pick(late, (m) => m.whPerKm, (m) => m.distKm);
    if (e0 && e1) {
      const pct = fmtPct(e0, e1);
      const dA = e0 / UNITS.dist(1), dB = e1 / UNITS.dist(1);
      out.push({
        kind: pct > 8 ? "warn" : pct < -5 ? "good" : "info",
        html: `Energy use ${pct >= 0 ? "up" : "down"} <b>${Math.abs(pct).toFixed(0)}%</b> ` +
              `(<b>${dA.toFixed(1)}</b> to <b>${dB.toFixed(1)}</b> Wh/${UNITS.distUnit}).`,
      });
    }

    // Temperature sensitivity (weather-only).
    if (tempFit) {
      const slopeDisp = UNITS.dist(tempFit.slope) / (UNITS.imperial ? 1.8 : 1);
      out.push({
        kind: "info",
        html: `Every <b>10 ${UNITS.tempUnit}</b> drop in ambient costs ` +
              `<b>${Math.abs(slopeDisp * 10).toFixed(1)}</b> ${UNITS.distUnit} of range.`,
      });
    }

    // Best month by distance.
    {
      const months = new Map();
      for (const m of dated) {
        const k = m.date.getFullYear() + "-" + String(m.date.getMonth()).padStart(2, "0");
        months.set(k, (months.get(k) || 0) + m.distKm);
      }
      let best = null;
      for (const [k, v] of months) if (!best || v > best.v) best = { k, v };
      if (best) {
        const [y, mo] = best.k.split("-").map(Number);
        const label = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(y, mo, 1));
        out.push({
          kind: "info",
          html: `Most active month: <b>${label}</b> with <b>${UNITS.dist(best.v).toFixed(0)}</b> ${UNITS.distUnit}.`,
        });
      }
    }

    return out;
  }

  function renderInsights() {
    const items = computeInsights();
    if (!items.length) { insightsBox.classList.add("hidden"); insightsList.innerHTML = ""; return; }
    insightsBox.classList.remove("hidden");
    insightsList.innerHTML = items.map((i) =>
      `<div class="insight ${i.kind}"><span class="ico"></span><div>${i.html}</div></div>`
    ).join("");
  }

  // Populate the green-bordered takeaway strip below a chart with the
  // headline number for that chart. `parts` is an array of HTML strings
  // joined with a visual separator.
  function setTakeaway(id, parts, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("warn");
    if (kind === "warn") el.classList.add("warn");
    const filtered = (parts || []).filter(Boolean);
    el.innerHTML = filtered.length ? filtered.join('<span class="ta-sep">·</span>') : "";
  }
  // Find peak / trough labels in a stats array (skipping null bins).
  function statsPeakTrough(stats, bins, label) {
    let peak = null, trough = null;
    for (let i = 0; i < stats.length; i++) {
      const st = stats[i];
      if (!st || st.med == null) continue;
      if (!peak || st.med > peak.v) peak = { v: st.med, label: bins[i].label };
      if (!trough || st.med < trough.v) trough = { v: st.med, label: bins[i].label };
    }
    return { peak, trough };
  }

  // Riding activity: bar = distance per bin, line = cumulative lifetime.
  function drawActivityChart(canvas, bins) {
    const cv = setupCanvas(canvas);
    if (!cv) return;
    const { ctx, w, h } = cv;
    const pad = { top: 14, bottom: 24, left: 46, right: 52 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const n = bins.length;
    if (!n) return;

    const distPerBin = bins.map((b) => b.trips.reduce((s, m) => s + m.distKm, 0));
    const cum = [];
    let acc = 0;
    for (const d of distPerBin) { acc += d; cum.push(acc); }
    const maxDist = Math.max(1, ...distPerBin);
    const maxCum = cum[cum.length - 1] || 1;

    const xAt = (i) => pad.left + (n > 1 ? (i / (n - 1)) * cw : cw / 2);
    const barW = n > 1 ? Math.max(2, (cw / n) * 0.7) : Math.max(8, cw * 0.3);

    ctx.font = FONT;
    // Grid + left axis (distance per bin).
    const leftTicks = niceTicks(0, UNITS.dist(maxDist), 4);
    ctx.fillStyle = AXIS_COLOR;
    ctx.strokeStyle = GRID_COLOR;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const tv of leftTicks) {
      const y = pad.top + ch - (tv / UNITS.dist(maxDist)) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillStyle = "#b388ff";
      ctx.fillText(fmtVal(tv), pad.left - 6, y);
    }
    // Right axis (cumulative).
    const rightTicks = niceTicks(0, UNITS.dist(maxCum), 4);
    ctx.textAlign = "left";
    ctx.fillStyle = "#69f0ae";
    for (const tv of rightTicks) {
      const y = pad.top + ch - (tv / UNITS.dist(maxCum)) * ch;
      ctx.fillText(fmtVal(tv), w - pad.right + 6, y);
    }

    // X labels.
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelStep = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += labelStep) {
      ctx.fillText(bins[i].label, xAt(i), pad.top + ch + 6);
    }

    // Bars.
    for (let i = 0; i < n; i++) {
      const v = distPerBin[i];
      if (v <= 0) continue;
      const x = xAt(i) - barW / 2;
      const yTop = pad.top + ch - (v / maxDist) * ch;
      const grad = ctx.createLinearGradient(0, yTop, 0, pad.top + ch);
      grad.addColorStop(0, "rgba(179,136,255,0.85)");
      grad.addColorStop(1, "rgba(179,136,255,0.25)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, yTop, barW, pad.top + ch - yTop);
    }

    // Cumulative line.
    ctx.strokeStyle = "#69f0ae";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const y = pad.top + ch - (cum[i] / maxCum) * ch;
      const x = xAt(i);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = "#69f0ae";
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(xAt(i), pad.top + ch - (cum[i] / maxCum) * ch, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Legend.
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(179,136,255,0.85)";
    ctx.fillRect(pad.left + 4, 6, 8, 3);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.textAlign = "left";
    ctx.fillText("Distance per group (" + UNITS.distUnit + ")", pad.left + 16, 11);
    const cumLabel = "Cumulative (" + UNITS.distUnit + ")";
    const offX = pad.left + 16 + ctx.measureText("Distance per group (" + UNITS.distUnit + ")").width + 20;
    ctx.fillStyle = "#69f0ae";
    ctx.fillRect(offX, 6, 8, 3);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText(cumLabel, offX + 12, 11);

    // Hover.
    canvas._an = {
      type: "trend",
      bins,
      pad, cw, ch, w, h, xAt,
      series: [
        { stats: distPerBin.map((v, i) => ({ med: v, n: bins[i].trips.length })), label: "Distance", unit: UNITS.distUnit, dp: 1, color: "#b388ff" },
        { stats: cum.map((v, i) => ({ med: v, n: bins[i].trips.length })), label: "Cumulative", unit: UNITS.distUnit, dp: 1, color: "#69f0ae" },
      ],
    };
    // Swap the getter so we report metric units.
    canvas._an.series[0].stats = distPerBin.map((v) => ({ med: UNITS.dist(v) }));
    canvas._an.series[1].stats = cum.map((v) => ({ med: UNITS.dist(v) }));
  }

  // Range vs ambient scatter — only shown when weather is loaded. Includes
  // the Theil–Sen fit line so the slope is visible, not just a number.
  function drawRangeTempScatter(canvas) {
    const pts = [];
    for (const m of dated) {
      if (m.estRangeKm == null || m.ambientC == null) continue;
      pts.push({
        x: UNITS.temp(m.ambientC),
        y: UNITS.dist(m.estRangeKm),
        epoch: m.epoch,
        meta: `<b>${m.label}</b><br>Range: <b>${fmtVal(UNITS.dist(m.estRangeKm), 1)}</b> ${UNITS.distUnit}` +
              `<br>Ambient: <b>${fmtVal(UNITS.temp(m.ambientC), 1)}</b> ${UNITS.tempUnit}` +
              `<br>Battery used: <b>${fmtVal(m.battDelta, 1)}</b>%`,
      });
    }
    if (pts.length < 6) { rangeTempHost.classList.add("hidden"); return; }
    rangeTempHost.classList.remove("hidden");
    drawScatter(canvas, pts, {
      xLabel: "ambient (" + UNITS.tempUnit + ")",
      yLabel: "est. range (" + UNITS.distUnit + ")",
    });
    // Overlay Theil–Sen fit line so the temperature relationship is visible.
    if (pts.length >= 10 && canvas._scatterMap) {
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const fitDisp = theilSen(xs, ys);
      if (fitDisp) {
        const { xAt, yAt, xMin, xMax } = canvas._scatterMap;
        const dpr = window.devicePixelRatio || 1;
        const ctx = canvas.getContext("2d");
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.strokeStyle = "rgba(255,241,118,0.75)";
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xAt(xMin), yAt(fitDisp.slope * xMin + fitDisp.intercept));
        ctx.lineTo(xAt(xMax), yAt(fitDisp.slope * xMax + fitDisp.intercept));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  // ---------- Render pipeline ----------
  function renderAll() {
    const minBattUse = Number(battMinSel.value);
    const minPerBin = Number(minBinSel.value);
    for (const m of dated) applyRangeGating(m, minBattUse);
    computeTempFit();

    const bins = makeBins(dated, groupSel.value);
    const rolling = rollingCheck.checked;

    renderLifetime();
    renderInsights();

    // Activity (cumulative + per-period distance).
    {
      const totalKm = bins.reduce((s, b) => s + b.trips.reduce((ss, m) => ss + m.distKm, 0), 0);
      document.getElementById("activity-meta").textContent =
        `${bins.length} groups · ${UNITS.dist(totalKm).toFixed(0)} ${UNITS.distUnit} total`;
      drawActivityChart(document.getElementById("chart-activity"), bins);
      // Headline numbers under the chart: biggest group + average pace.
      let peak = null;
      for (const b of bins) {
        const km = b.trips.reduce((s, m) => s + m.distKm, 0);
        if (km > 0 && (!peak || km > peak.km)) peak = { km, label: b.label };
      }
      const nonEmpty = bins.filter((b) => b.trips.length > 0).length;
      const parts = [];
      if (peak) parts.push(`Biggest group: <b>${peak.label}</b> with <b>${UNITS.dist(peak.km).toFixed(0)}</b> ${UNITS.distUnit}`);
      if (nonEmpty) parts.push(`Active in <b>${nonEmpty}</b> of ${bins.length} groups (avg <b>${UNITS.dist(totalKm / nonEmpty).toFixed(0)}</b> ${UNITS.distUnit} per active group)`);
      setTakeaway("activity-takeaway", parts);
    }

    // 1. Range.
    {
      const usable = dated.filter((m) => m.estRangeKm != null).length;
      const meta = document.getElementById("range-meta");
      if (!usable) {
        setSectionEmpty("range", "No trips used at least " + minBattUse + "% battery. Lower the threshold, or these exports may carry no battery level.");
        meta.textContent = "";
        rangeTempHost.classList.add("hidden");
        setTakeaway("range-takeaway", []);
        setTakeaway("range-temp-takeaway", []);
      } else {
        setSectionActive("range");
        const rangeStats = binStats(bins, (m) => m.estRangeKm == null ? null : UNITS.dist(normalizedRange(m)), minPerBin);
        const series = [{
          stats: rangeStats,
          color: normalizeCheck.checked ? COLORS.rangeNorm : COLORS.range,
          label: normalizeCheck.checked ? "Est. range (20 °C norm.)" : "Est. full range",
          unit: UNITS.distUnit, band: true, dp: 1,
        }];
        drawTrendChart(document.getElementById("chart-range"), bins, series, { rolling, zeroBase: false });
        let metaTxt = usable + " of " + dated.length + " trips usable";
        if (tempFit) {
          const slopeDisp = UNITS.dist(tempFit.slope) / (UNITS.imperial ? 1.8 : 1);
          metaTxt += ` · temp sensitivity ${fmtVal(slopeDisp, 2)} ${UNITS.distUnit}/${UNITS.tempUnit}`;
        }
        meta.textContent = metaTxt;
        // Takeaway: peak / trough range by group.
        const { peak, trough } = statsPeakTrough(rangeStats, bins);
        const trendParts = [];
        if (peak) trendParts.push(`Best range: <b>${peak.v.toFixed(0)} ${UNITS.distUnit}</b> in <b>${peak.label}</b>`);
        if (trough && peak && trough.label !== peak.label) trendParts.push(`Lowest: <b>${trough.v.toFixed(0)} ${UNITS.distUnit}</b> in <b>${trough.label}</b>`);
        if (!normalizeCheck.checked && !tempFit) trendParts.push('Enrich with weather to control for temperature');
        setTakeaway("range-takeaway", trendParts);
        if (weatherLoaded) {
          drawRangeTempScatter(document.getElementById("chart-range-temp"));
          if (tempFit) {
            const slopeDisp = UNITS.dist(tempFit.slope) / (UNITS.imperial ? 1.8 : 1);
            // Show the per-degree cost and the 10-degree headline so readers
            // who think in big swings get the practical number too.
            const perStep = Math.abs(slopeDisp);
            setTakeaway("range-temp-takeaway", [
              `Each <b>1 ${UNITS.tempUnit}</b> colder costs about <b>${perStep.toFixed(2)} ${UNITS.distUnit}</b> of range`,
              `A <b>10 ${UNITS.tempUnit}</b> swing is worth <b>${(perStep * 10).toFixed(1)} ${UNITS.distUnit}</b>`,
            ]);
          } else {
            setTakeaway("range-temp-takeaway", ["Not enough trips with both battery use and ambient temp to fit a slope yet"]);
          }
        } else {
          rangeTempHost.classList.add("hidden");
          setTakeaway("range-temp-takeaway", []);
        }
      }
    }

    // 2. Efficiency.
    {
      const hasWh = dated.some((m) => m.whPerKm != null);
      const hasKmPct = dated.some((m) => m.kmPerPct != null);
      const meta = document.getElementById("efficiency-meta");
      if (!hasWh && !hasKmPct) {
        setSectionEmpty("efficiency", "These exports carry no power/current or battery columns, so efficiency can't be computed.");
        meta.textContent = "";
        setTakeaway("efficiency-takeaway", []);
      } else {
        setSectionActive("efficiency");
        const series = [];
        let whStats = null;
        if (hasWh) {
          whStats = binStats(bins, (m) => m.whPerKm == null ? null : m.whPerKm / UNITS.dist(1), minPerBin);
          series.push({
            stats: whStats,
            color: COLORS.whPerKm, label: "Wh/" + UNITS.distUnit, unit: "Wh/" + UNITS.distUnit, band: true, dp: 1,
          });
        }
        if (hasKmPct) series.push({
          stats: binStats(bins, (m) => m.kmPerPct == null ? null : UNITS.dist(m.kmPerPct), minPerBin),
          color: COLORS.kmPerPct, label: UNITS.distUnit + "/%", unit: UNITS.distUnit + "/%", band: false, dp: 2,
        });
        drawTrendChart(document.getElementById("chart-efficiency"), bins, series, { rolling });
        meta.textContent = "";
        if (whStats) {
          const { peak, trough } = statsPeakTrough(whStats, bins);
          const parts = [];
          if (peak && trough && peak.label !== trough.label) {
            parts.push(`Best: <b>${trough.v.toFixed(1)} Wh/${UNITS.distUnit}</b> in <b>${trough.label}</b>`);
            parts.push(`Worst: <b>${peak.v.toFixed(1)} Wh/${UNITS.distUnit}</b> in <b>${peak.label}</b>`);
          }
          setTakeaway("efficiency-takeaway", parts);
        }
      }
    }

    // 3. Motor: speed vs current scatter + amps-per-km/h trend.
    {
      const pts = [];
      for (const m of dated) {
        if (m.avgMovingSpeed == null || m.avgCurrent == null) continue;
        pts.push({
          x: UNITS.speed(m.avgMovingSpeed),
          y: m.avgCurrent,
          epoch: m.epoch,
          meta: `<b>${m.label}</b><br>Avg speed: <b>${fmtVal(UNITS.speed(m.avgMovingSpeed), 1)}</b> ${UNITS.speedUnit}` +
                `<br>Avg current: <b>${fmtVal(m.avgCurrent, 1)}</b> A` +
                `<br>Distance: <b>${fmtVal(UNITS.dist(m.distKm), 1)}</b> ${UNITS.distUnit}`,
        });
      }
      const meta = document.getElementById("motor-meta");
      if (pts.length < 5) {
        setSectionEmpty("motor", "Not enough trips with current data for this analysis.");
        meta.textContent = "";
        setTakeaway("motor-takeaway", []);
        setTakeaway("motor-trend-takeaway", []);
      } else {
        setSectionActive("motor");
        drawScatter(document.getElementById("chart-motor"), pts, {
          xLabel: "avg speed (" + UNITS.speedUnit + ")", yLabel: "avg current (A)",
        });
        // Slope of current vs speed across all trips (single fit).
        const xsAll = pts.map((p) => p.x), ysAll = pts.map((p) => p.y);
        const fit = theilSen(xsAll, ysAll);
        const scatterParts = [];
        if (fit) scatterParts.push(`Slope: <b>${fit.slope.toFixed(2)} A per ${UNITS.speedUnit}</b>`);
        scatterParts.push(`<b>${pts.length}</b> trips plotted`);
        setTakeaway("motor-takeaway", scatterParts);
        const trendStats = binStats(bins, (m) => (m.avgMovingSpeed != null && m.avgCurrent != null && m.avgMovingSpeed > 5)
          ? m.avgCurrent / UNITS.speed(m.avgMovingSpeed) : null, minPerBin);
        const series = [{
          stats: trendStats,
          color: COLORS.ampsPerKmh, label: "A per " + UNITS.speedUnit, unit: "A/(" + UNITS.speedUnit + ")", band: true, dp: 3,
        }];
        drawTrendChart(document.getElementById("chart-motor-trend"), bins, series, { rolling });
        meta.textContent = pts.length + " trips";
        const { peak, trough } = statsPeakTrough(trendStats, bins);
        const trendParts = [];
        if (peak && trough && peak.label !== trough.label) {
          const pct = ((peak.v - trough.v) / trough.v) * 100;
          trendParts.push(`Lowest draw: <b>${trough.v.toFixed(3)} A/${UNITS.speedUnit}</b> in <b>${trough.label}</b>`);
          trendParts.push(`Highest: <b>${peak.v.toFixed(3)}</b> in <b>${peak.label}</b> (+${pct.toFixed(0)}%)`);
        }
        setTakeaway("motor-trend-takeaway", trendParts);
      }
    }

    // 4. Thermal.
    {
      const useAmbient = weatherLoaded && dated.some((m) => m.ambientC != null && m.tempMax != null);
      const tempRiseOf = (m) => {
        if (m.tempMax == null) return null;
        if (useAmbient) return m.ambientC != null ? m.tempMax - m.ambientC : null;
        return m.tempStart != null ? m.tempMax - m.tempStart : null;
      };
      const pts = [];
      for (const m of dated) {
        const rise = tempRiseOf(m);
        if (rise == null || m.avgPower == null) continue;
        pts.push({
          x: m.avgPower,
          y: tempDelta(rise),
          epoch: m.epoch,
          meta: `<b>${m.label}</b><br>Temp rise: <b>${fmtVal(tempDelta(rise), 1)}</b> ${UNITS.tempUnit}` +
                `<br>Avg power: <b>${fmtVal(m.avgPower, 0)}</b> W` +
                (m.ambientC != null ? `<br>Ambient: <b>${fmtVal(UNITS.temp(m.ambientC), 1)}</b> ${UNITS.tempUnit}` : ""),
        });
      }
      const meta = document.getElementById("thermal-meta");
      if (pts.length < 5) {
        setSectionEmpty("thermal", "Not enough trips with temperature + power data for this analysis.");
        meta.textContent = "";
        setTakeaway("thermal-takeaway", []);
        setTakeaway("thermal-trend-takeaway", []);
      } else {
        setSectionActive("thermal");
        drawScatter(document.getElementById("chart-thermal"), pts, {
          xLabel: "avg power (W)", yLabel: "temp rise (" + UNITS.tempUnit + ")",
        });
        const xsAll = pts.map((p) => p.x), ysAll = pts.map((p) => p.y);
        const fit = theilSen(xsAll, ysAll);
        const scatterParts = [];
        if (fit) scatterParts.push(`Slope: <b>${(fit.slope * 1000).toFixed(2)} ${UNITS.tempUnit} per kW</b>`);
        scatterParts.push(useAmbient ? "Rise measured vs ambient" : "Rise measured vs trip-start temp");
        setTakeaway("thermal-takeaway", scatterParts);
        const trendStats = binStats(bins, (m) => {
          const r = tempRiseOf(m);
          return r == null ? null : tempDelta(r);
        }, minPerBin);
        const series = [{
          stats: trendStats,
          color: COLORS.tempRise, label: "Median temp rise", unit: UNITS.tempUnit, band: true, dp: 1,
        }];
        drawTrendChart(document.getElementById("chart-thermal-trend"), bins, series, { rolling });
        meta.textContent = useAmbient ? "vs ambient (weather)" : "vs trip-start temp. Add weather for an ambient baseline.";
        const { peak, trough } = statsPeakTrough(trendStats, bins);
        const trendParts = [];
        if (peak && trough && peak.label !== trough.label) {
          trendParts.push(`Coolest: <b>${trough.v.toFixed(1)} ${UNITS.tempUnit}</b> in <b>${trough.label}</b>`);
          trendParts.push(`Hottest: <b>${peak.v.toFixed(1)} ${UNITS.tempUnit}</b> in <b>${peak.label}</b>`);
        }
        setTakeaway("thermal-trend-takeaway", trendParts);
      }
    }

    // 5. Battery health (IR).
    {
      const usable = dated.filter((m) => m.ohmIR != null).length;
      const meta = document.getElementById("health-meta");
      if (usable < 5) {
        setSectionEmpty("health", "Not enough trips with voltage + current data to estimate internal resistance.");
        meta.textContent = "";
        setTakeaway("health-takeaway", []);
      } else {
        setSectionActive("health");
        const irStats = binStats(bins, (m) => m.ohmIR == null ? null : m.ohmIR * 1000, Math.max(2, minPerBin));
        const series = [{
          stats: irStats,
          color: COLORS.ohmIR, label: "Effective IR", unit: "mΩ", band: true, dp: 0,
        }];
        drawTrendChart(document.getElementById("chart-health"), bins, series, { rolling, zeroBase: true });
        meta.textContent = usable + " trips";
        const { peak, trough } = statsPeakTrough(irStats, bins);
        const parts = [];
        if (peak && trough && peak.label !== trough.label) {
          const pct = ((peak.v - trough.v) / trough.v) * 100;
          parts.push(`Lowest IR: <b>${trough.v.toFixed(0)} mΩ</b> in <b>${trough.label}</b>`);
          parts.push(`Highest: <b>${peak.v.toFixed(0)} mΩ</b> in <b>${peak.label}</b> (+${pct.toFixed(0)}%)`);
        }
        setTakeaway("health-takeaway", parts, peak && trough && ((peak.v - trough.v) / trough.v) > 0.25 ? "warn" : null);
      }
    }
  }

  groupSel.addEventListener("change", renderAll);
  battMinSel.addEventListener("change", renderAll);
  minBinSel.addEventListener("change", renderAll);
  rollingCheck.addEventListener("change", renderAll);
  normalizeCheck.addEventListener("change", renderAll);
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 150);
  });

  renderAll();

  // Pre-fill ambient temps from the cache (no network) so a returning user
  // gets the weather-based view without pressing the button again.
  (async () => {
    const clusters = weatherClusters();
    let hits = 0;
    for (const c of clusters) {
      const cached = await readWeatherCache(c.key);
      if (!cached) continue;
      for (const m of c.trips) {
        const day = cached.days[m.dateStr];
        if (day) { m.ambientC = day.mean; hits++; }
      }
    }
    if (hits) {
      weatherLoaded = true;
      weatherStatus.textContent = `Ambient temp for ${hits} trips (cached)`;
      weatherStatus.className = "ok";
      const allCovered = dated.every((m) => m.ambientC != null || !m.centroid);
      if (allCovered) weatherBtn.textContent = "Weather added";
    }
    renderAll();
  })();
})();
