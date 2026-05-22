(async function () {
  "use strict";

  // Imperial unit toggle — drives display labels and converters everywhere
  // values are shown. Override with ?units=imperial / ?units=metric.
  const UNITS = (() => {
    const force = new URLSearchParams(location.search).get("units");
    let imperial = force === "imperial";
    if (!force) {
      try {
        const loc = new Intl.Locale(navigator.language || "en").maximize();
        if (loc.region === "US") imperial = true;
      } catch (_) {}
    }
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
  function convertByKind(kind, v) {
    if (kind === "speed") return UNITS.speed(v);
    if (kind === "temp")  return UNITS.temp(v);
    if (kind === "alt")   return UNITS.alt(v);
    if (kind === "dist")  return UNITS.dist(v);
    return v;
  }
  // Apply the user's units to every static unit label in the dashboard.
  function applyUnitLabels() {
    document.querySelectorAll(".unit-speed").forEach(e => e.textContent = UNITS.speedUnit);
    document.querySelectorAll(".unit-dist").forEach(e => e.textContent = UNITS.distUnit);
    document.querySelectorAll(".unit-temp").forEach(e => e.textContent = UNITS.tempUnit);
    document.querySelectorAll(".unit-alt").forEach(e => e.textContent = UNITS.altUnit);
  }
  applyUnitLabels();

  // ---------- Load track ----------
  const params = new URLSearchParams(location.search);
  const trackIdx = parseInt(params.get("i"));
  const errorBanner = document.getElementById("error-banner");

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove("hidden");
  }

  const RECENT_DB_NAME = "eucplanet-trip-viewer";
  const SESSION_STORE_NAME = "currentSession";
  const SESSION_KEY = "tracks";

  function loadFromIDB() {
    return new Promise((resolve) => {
      if (!("indexedDB" in window)) return resolve(null);
      const req = indexedDB.open(RECENT_DB_NAME);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) { db.close(); return resolve(null); }
        try {
          const tx = db.transaction(SESSION_STORE_NAME, "readonly");
          const getReq = tx.objectStore(SESSION_STORE_NAME).get(SESSION_KEY);
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || null); };
          getReq.onerror = () => { db.close(); resolve(null); };
        } catch { db.close(); resolve(null); }
      };
    });
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

  if (!tracks || !Array.isArray(tracks) || isNaN(trackIdx) || !tracks[trackIdx]) {
    showError("Trip not found. Open the main viewer and click a trip's inspect button.");
    return;
  }
  const track = tracks[trackIdx];
  const ts = track.timeseries || [];
  if (ts.length < 2) {
    showError("Trip has no timeseries data to play back.");
    return;
  }

  // Timeseries layout: [sec, speed, voltage, temp, battery, altitude, lat, lon, mileageKm,
  //                     pwm, current, power, gpsSpeed, gForce, gForceX, gForceY]
  // Indices 12-15 are absent on legacy cached tracks — always guard for undefined.
  const SEC = 0, SPD = 1, VOLT = 2, TEMP = 3, BATT = 4, ALT = 5, LAT = 6, LON = 7, MILEAGE = 8;
  const PWM = 9, CURRENT = 10, POWER = 11;
  const GPSSPD = 12, GFORCE = 13, GFORCEX = 14, GFORCEY = 15;
  // Points layout: [lat, lon, speed, alt, volt, temp, battery, pwm, current, power, gpsSpeed]
  const P_LAT = 0, P_LON = 1, P_SPD = 2, P_ALT = 3, P_VOLT = 4, P_TEMP = 5, P_BATT = 6;
  const P_PWM = 7, P_CURRENT = 8, P_POWER = 9, P_GPSSPD = 10;

  // GPS speed overlays the wheel-speed chart as a dashed companion line.
  const GPS_COLOR = "#80d8ff";

  const duration = ts[ts.length - 1][SEC] - ts[0][SEC];
  const t0 = ts[0][SEC];

  // Cumulative distance (km) aligned with timeseries
  const cumKm = new Float32Array(ts.length);
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  let prevLat = null, prevLon = null, total = 0;
  for (let i = 0; i < ts.length; i++) {
    const lat = ts[i][LAT], lon = ts[i][LON];
    if (lat !== 0 && lon !== 0) {
      if (prevLat !== null) total += haversineKm(prevLat, prevLon, lat, lon);
      prevLat = lat; prevLon = lon;
    }
    cumKm[i] = total;
  }
  let totalKm = total;

  // Fallback #1: no GPS but CSV provides "Total mileage" odometer → use it.
  if (totalKm === 0 && ts[0].length > MILEAGE) {
    let lastMi = 0;
    for (let i = 0; i < ts.length; i++) {
      const mi = ts[i][MILEAGE] || 0;
      if (mi > lastMi) lastMi = mi;
      cumKm[i] = lastMi;
    }
    totalKm = lastMi;
  }

  // Fallback #2: still nothing → integrate speed (km/h) over elapsed time.
  // Works for legacy cached tracks that don't carry the mileage column.
  if (totalKm === 0) {
    let running = 0;
    cumKm[0] = 0;
    for (let i = 1; i < ts.length; i++) {
      const dtSec = Math.max(0, ts[i][SEC] - ts[i - 1][SEC]);
      const avgSpd = (ts[i][SPD] + ts[i - 1][SPD]) / 2; // km/h
      running += (avgSpd * dtSec) / 3600;
      cumKm[i] = running;
    }
    totalKm = running;
  }

  // ---------- Header info ----------
  document.getElementById("trip-name").textContent = track.date || track.name;
  const subBits = [];
  if (track.stats) {
    if (track.stats.distanceKm) subBits.push(UNITS.dist(track.stats.distanceKm).toFixed(2) + " " + UNITS.distUnit);
    if (track.stats.maxSpeed) subBits.push(UNITS.speed(track.stats.maxSpeed).toFixed(0) + " " + UNITS.speedUnit + " max");
    subBits.push((track.stats.rows || ts.length).toLocaleString() + " samples");
  }
  document.getElementById("trip-subtitle").textContent = subBits.join(" \u00b7 ");
  document.getElementById("clock-total").textContent = fmtTime(duration);

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  // toFixed but without a "-0.00" sign on values that round to zero.
  function fmtFixed(value, dp) {
    const s = value.toFixed(dp);
    return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
  }

  // ---------- MapLibre map ----------
  function hasGpsRow(row) {
    return row[LAT] !== 0 && row[LON] !== 0;
  }

  const gpsPoints = ts.filter(hasGpsRow);
  let routePoints = Array.isArray(track.points) ? track.points.filter((p) => p[P_LAT] !== 0 && p[P_LON] !== 0) : [];
  if (routePoints.length < 2) {
    // Fallback for legacy payloads: reconstruct route from timeseries GPS rows.
    routePoints = gpsPoints.map((r) => [r[LAT], r[LON], r[SPD], r[ALT], r[VOLT], r[TEMP], r[BATT], r[PWM], r[CURRENT], r[POWER], r[GPSSPD]]);
  }
  const hasGps = routePoints.length > 1;

  // Basemap themes — each builds a {source, layer} pair inserted below the track.
  const MAP_THEMES = {
    dark: {
      source: {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
        ],
        tileSize: 256,
        attribution: "\u00a9 OpenStreetMap contributors \u00a9 CARTO"
      },
      paint: {}
    },
    light: {
      source: {
        type: "raster",
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
        ],
        tileSize: 256,
        attribution: "\u00a9 OpenStreetMap contributors"
      },
      paint: {}
    },
    satellite: {
      source: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Tiles \u00a9 Esri"
      },
      paint: {}
    }
  };

  // Color-by configs: invert=true means high value is "good" (green end of palette).
  const COLOR_MODES = {
    speed:    { pointIdx: P_SPD,     unit: "km/h", invert: false, unitKind: "speed" },
    gpsspeed: { pointIdx: P_GPSSPD,  unit: "km/h", invert: false, unitKind: "speed" },
    pwm:      { pointIdx: P_PWM,     unit: "%",    invert: false },
    power:    { pointIdx: P_POWER,   unit: "W",    invert: false },
    current:  { pointIdx: P_CURRENT, unit: "A",    invert: false },
    battery:  { pointIdx: P_BATT,    unit: "%",    invert: true  },
    voltage:  { pointIdx: P_VOLT,    unit: "V",    invert: true  },
    temp:     { pointIdx: P_TEMP,    unit: "\u00b0C", invert: false, unitKind: "temp" },
    altitude: { pointIdx: P_ALT,     unit: "m",    invert: false, unitKind: "alt" }
  };
  // Palette low → high; inverted modes reverse stops.
  const PALETTE = ["#2962ff", "#00e5ff", "#69f0ae", "#ffeb3b", "#ff5252"];

  let map = null, riderMarker = null;
  let followPan = true, followRotate = true, followZoom = true;
  let lastFollowAt = 0;

  // Smoothed zoom target. Speed≤10 km/h → ZOOM_MAX (close); ≥40 km/h → ZOOM_MIN (wide).
  const ZOOM_MIN = 10.0, ZOOM_MAX = 15.0, SPEED_LO = 10, SPEED_HI = 50;
  let smoothedZoom = null;
  const ZOOM_ALPHA = 0.06;
  function targetZoomForSpeed(speed) {
    if (speed <= SPEED_LO) return ZOOM_MAX;
    if (speed >= SPEED_HI) return ZOOM_MIN;
    const t = (speed - SPEED_LO) / (SPEED_HI - SPEED_LO);
    return ZOOM_MAX + (ZOOM_MIN - ZOOM_MAX) * t;
  }
  function stepSmoothZoom(target) {
    if (smoothedZoom === null) { smoothedZoom = target; return smoothedZoom; }
    smoothedZoom = smoothedZoom + (target - smoothedZoom) * ZOOM_ALPHA;
    return smoothedZoom;
  }

  // Bearing in degrees (0 = north, clockwise) from coord a→b.
  function bearingBetween(a, b) {
    const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
    const lon1 = a[0] * toRad, lat1 = a[1] * toRad;
    const lon2 = b[0] * toRad, lat2 = b[1] * toRad;
    const dLon = lon2 - lon1;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * toDeg + 360) % 360;
  }
  // Average travel direction around `idx` using a wide window so GPS jitter
  // doesn't swing the heading. Tuned large to complement the EMA smoothing.
  function computeBearingAt(idx) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const lookback = 10, lookahead = 20;
    const a = coords[Math.max(0, idx - lookback)];
    const b = coords[Math.min(coords.length - 1, idx + lookahead)];
    if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return null;
    return bearingBetween(a, b);
  }

  // EMA-smoothed bearing target. With ~4 ticks/sec and α=0.08 the effective
  // time constant is ~3 s — ≈8× smoother than the previous snap-per-tick.
  let smoothedBearing = null;
  const BEARING_ALPHA = 0.08;
  function stepSmoothBearing(targetDeg) {
    if (targetDeg === null) return smoothedBearing;
    if (smoothedBearing === null) { smoothedBearing = targetDeg; return smoothedBearing; }
    const diff = ((targetDeg - smoothedBearing + 540) % 360) - 180;
    smoothedBearing = (smoothedBearing + diff * BEARING_ALPHA + 360) % 360;
    return smoothedBearing;
  }
  let coords = [];
  let currentTheme = "satellite";
  let currentColorMode = "solid";
  let currentTraceMode = "trail-fixed"; // trail-fixed | trail-dynamic | whole
  let currentRouteIdx = 0;

  function applyTheme(name) {
    if (!map || !map.isStyleLoaded()) return;
    const theme = MAP_THEMES[name];
    if (!theme) return;
    if (map.getLayer("basemap")) map.removeLayer("basemap");
    if (map.getSource("basemap")) map.removeSource("basemap");
    map.addSource("basemap", theme.source);
    const before = map.getLayer("track-line") ? "track-line" : undefined;
    map.addLayer({ id: "basemap", type: "raster", source: "basemap", paint: theme.paint }, before);
    currentTheme = name;
  }

  function metricColor(value, minV, maxV, invert) {
    const stops = invert ? PALETTE.slice().reverse() : PALETTE;
    const t = Math.max(0, Math.min(1, (value - minV) / (maxV - minV)));
    const pos = t * (stops.length - 1);
    const i = Math.floor(pos);
    const f = pos - i;
    if (i >= stops.length - 1) return stops[stops.length - 1];
    return lerpColor(stops[i], stops[i + 1], f);
  }

  // Value range for a metric. With `endIdx` the scan is limited to the
  // traveled portion [0..endIdx] (live scale); without it, the whole trip.
  function getModeStats(mode, endIdx) {
    const cfg = COLOR_MODES[mode];
    if (!cfg || !routePoints.length) return null;
    const end = endIdx == null
      ? routePoints.length - 1
      : Math.max(0, Math.min(endIdx, routePoints.length - 1));
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i <= end; i++) {
      const v = routePoints[i][cfg.pointIdx];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (!isFinite(minV) || !isFinite(maxV)) return null;
    if (minV === maxV) maxV = minV + 1;
    return { min: minV, max: maxV, invert: cfg.invert, unit: cfg.unit, unitKind: cfg.unitKind };
  }

  // Builds a line-gradient expression for coords[0..endIdx]. Each vertex's
  // colour is pinned to its true distance fraction along the line, so the
  // palette stays locked to the ground as the trail grows — no crawling.
  function buildTraceGradient(mode, endIdx, stats) {
    const cfg = COLOR_MODES[mode];
    if (!cfg || !stats) return null;
    const end = Math.max(0, Math.min(endIdx, coords.length - 1, routePoints.length - 1));
    if (end < 1) return null;
    let tot = 0;
    const cum = new Float64Array(end + 1);
    for (let i = 1; i <= end; i++) {
      tot += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
      cum[i] = tot;
    }
    if (tot <= 0) return null;
    const expr = ["interpolate", ["linear"], ["line-progress"]];
    // Downsample against the FULL route length, not the growing traveled
    // length — a constant step keeps the same vertices carrying colour stops
    // every frame, so the drawn trail's colours don't re-sample as it grows.
    const step = Math.max(1, Math.floor(coords.length / 150));
    let lastP = -1;
    for (let i = 0; i <= end; i += step) {
      const p = cum[i] / tot;
      if (p <= lastP) continue;
      expr.push(p, metricColor(routePoints[i][cfg.pointIdx], stats.min, stats.max, stats.invert));
      lastP = p;
    }
    if (lastP < 1) {
      expr.push(1, metricColor(routePoints[end][cfg.pointIdx], stats.min, stats.max, stats.invert));
    }
    return expr;
  }

  function lerpColor(a, b, t) {
    const pa = parseHex(a), pb = parseHex(b);
    const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return "rgb(" + r + "," + g + "," + bl + ")";
  }
  function parseHex(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function updateLegend(stats) {
    const legend = document.getElementById("color-legend");
    if (!stats) { legend.classList.add("hidden"); return; }
    legend.querySelector(".legend-bar").classList.toggle("inverted", !!stats.invert);
    // Speed / temp / altitude metrics get the locale-appropriate label and
    // converted bounds; other metrics (V, A, W, %) keep their static units.
    const kind = stats.unitKind;
    const unit = kind === "speed" ? UNITS.speedUnit
               : kind === "temp"  ? UNITS.tempUnit
               : kind === "alt"   ? UNITS.altUnit
               : stats.unit;
    const conv = (v) => kind ? convertByKind(kind, v) : v;
    const fmt = (v) => {
      const c = conv(v);
      return (Math.abs(c) >= 100 ? c.toFixed(0) : c.toFixed(1)) + " " + unit;
    };
    legend.querySelector("[data-legend-min]").textContent = fmt(stats.min);
    legend.querySelector("[data-legend-max]").textContent = fmt(stats.max);
    legend.classList.remove("hidden");
  }

  // Refreshes the moving trail gradient. No-op for "whole" and "solid",
  // which are static and fully handled by applyTrace().
  function updateTraceGradient() {
    if (currentColorMode === "solid" || currentTraceMode === "whole") return;
    if (!map || !map.getLayer("traveled-line")) return;
    const stats = currentTraceMode === "trail-dynamic"
      ? getModeStats(currentColorMode, currentRouteIdx)
      : getModeStats(currentColorMode);
    if (!stats) return;
    const expr = buildTraceGradient(currentColorMode, currentRouteIdx, stats);
    if (expr) {
      map.setPaintProperty("traveled-line", "line-gradient", expr);
      map.setPaintProperty("traveled-line", "line-color", "#ffffff");
    }
    updateLegend(stats);
  }

  // Applies the current Trace color + Trace mode pair to the two line layers.
  // Sets up the static parts only; the moving trail is filled by
  // updateTraceGradient() (here and once per playback frame).
  //   trail-fixed   — trail behind the marker, colour scale from the whole trip
  //   trail-dynamic — trail behind the marker, scale = min/max of trail so far
  //   whole         — entire route at once, colour scale from the whole trip
  function applyTrace() {
    if (!map || !map.getLayer("track-line") || !map.getLayer("traveled-line")) return;
    const mode = currentColorMode;
    const whole = currentTraceMode === "whole";

    // Reset both layers to a known baseline.
    map.setPaintProperty("track-line", "line-gradient", undefined);
    map.setPaintProperty("traveled-line", "line-gradient", undefined);

    if (mode === "solid") {
      updateLegend(null);
      if (whole) {
        // Whole path, single colour, no reveal trail.
        map.setLayoutProperty("traveled-line", "visibility", "none");
        map.setPaintProperty("track-line", "line-color", "#ffa000");
        map.setPaintProperty("track-line", "line-opacity", 0.9);
      } else {
        map.setLayoutProperty("traveled-line", "visibility", "visible");
        map.setPaintProperty("traveled-line", "line-color", "#ffa000");
        map.setPaintProperty("track-line", "line-color", "#00e5ff");
        map.setPaintProperty("track-line", "line-opacity", 0.85);
      }
      return;
    }

    if (whole) {
      // Colour the entire route on the base track layer; hide the trail.
      const stats = getModeStats(mode);
      const expr = buildTraceGradient(mode, coords.length - 1, stats);
      map.setLayoutProperty("traveled-line", "visibility", "none");
      map.setPaintProperty("track-line", "line-opacity", 0.95);
      if (expr) {
        map.setPaintProperty("track-line", "line-gradient", expr);
        map.setPaintProperty("track-line", "line-color", "#ffffff");
      }
      updateLegend(stats);
      return;
    }

    // trail-fixed / trail-dynamic: faint full-route ghost + gradient trail.
    map.setLayoutProperty("traveled-line", "visibility", "visible");
    map.setPaintProperty("traveled-line", "line-color", "#ffa000");
    map.setPaintProperty("track-line", "line-color", "#00e5ff");
    map.setPaintProperty("track-line", "line-opacity", 0.35);
    updateTraceGradient();
  }

  // "Trail (dynamic)" needs a metric to scale against, so it is only valid
  // when Trace color is a metric. Disable it for Solid and, if it was the
  // active choice, fall back to "Trail (fixed)".
  function syncTraceModeOptions() {
    const sel = document.getElementById("trace-mode-select");
    if (!sel) return;
    const dynOpt = sel.querySelector('option[value="trail-dynamic"]');
    const solid = currentColorMode === "solid";
    if (dynOpt) dynOpt.disabled = solid;
    if (solid && currentTraceMode === "trail-dynamic") {
      currentTraceMode = "trail-fixed";
      sel.value = "trail-fixed";
    }
  }

  // Greys out trace-colour options that have no chart — i.e. metrics this trip
  // carries no data for — so the colour picker matches the charts shown.
  // Falls back to Solid if the active colour becomes unavailable.
  function syncColorSelectOptions() {
    const sel = document.getElementById("color-select");
    if (!sel) return;
    for (const opt of sel.options) {
      const key = opt.value;
      if (key === "solid") { opt.disabled = false; continue; }
      // GPS speed has no chart block — it lives on the speed chart. Toggle it
      // by whether the trip carries the column.
      if (key === "gpsspeed") { opt.disabled = !hasGpsSpeed; continue; }
      const block = document.querySelector(`.chart-block[data-key="${key}"]`);
      opt.disabled = !block || block.classList.contains("hidden");
    }
    // "Speed" trace is the wheel's dial speed — name it "Wheel speed" when GPS
    // speed is also available so the two metrics read distinctly.
    const speedOpt = sel.querySelector('option[value="speed"]');
    if (speedOpt) speedOpt.textContent = hasGpsSpeed ? "Wheel speed" : "Speed";
    if (currentColorMode !== "solid") {
      const active = sel.querySelector(`option[value="${currentColorMode}"]`);
      if (active && active.disabled) {
        currentColorMode = "solid";
        sel.value = "solid";
      }
    }
  }

  if (hasGps) {
    const lats = routePoints.map(p => p[P_LAT]);
    const lons = routePoints.map(p => p[P_LON]);
    const center = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];

    const initialTheme = MAP_THEMES[currentTheme] || MAP_THEMES.dark;
    map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          "basemap": initialTheme.source,
          "terrain-dem": {
            type: "raster-dem",
            tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
            tileSize: 256,
            encoding: "terrarium",
            maxzoom: 15
          }
        },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#0a0a0a" } },
          { id: "basemap", type: "raster", source: "basemap", paint: initialTheme.paint }
        ]
      },
      center,
      zoom: 14,
      pitch: 60,
      bearing: 0,
      maxPitch: 85,
      attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("load", () => {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });

      coords = routePoints.map((p) => [p[P_LON], p[P_LAT]]);
      map.addSource("track", {
        type: "geojson",
        lineMetrics: true,
        data: { type: "Feature", geometry: { type: "LineString", coordinates: coords } }
      });
      map.addLayer({
        id: "track-line",
        type: "line",
        source: "track",
        paint: {
          "line-color": "#00e5ff",
          "line-width": 4,
          "line-opacity": 0.85
        }
      });

      map.addSource("traveled", {
        type: "geojson",
        lineMetrics: true,
        data: { type: "Feature", geometry: { type: "LineString", coordinates: [coords[0]] } }
      });
      map.addLayer({
        id: "traveled-line",
        type: "line",
        source: "traveled",
        paint: {
          "line-color": "#ffa000",
          "line-width": 5,
          "line-opacity": 1.0
        }
      });

      const b = new maplibregl.LngLatBounds();
      coords.forEach(c => b.extend(c));
      map.fitBounds(b, { padding: 40, pitch: 60, duration: 0 });

      const el = document.createElement("div");
      el.className = "rider-dot";
      riderMarker = new maplibregl.Marker({ element: el })
        .setLngLat(coords[0])
        .addTo(map);

      // Any user-initiated map movement disables follow. MapLibre tags
      // programmatic easeTo/jumpTo calls without an originalEvent, so we
      // only flip the flag for real user input (drag/rotate/pitch/zoom).
      map.on("movestart", (e) => {
        if (e && e.originalEvent) {
          followPan = false;
          followRotate = false;
          followZoom = false;
          const fp = document.getElementById("follow-pan");
          const fr = document.getElementById("follow-rotate");
          const fz = document.getElementById("follow-zoom");
          if (fp) fp.checked = false;
          if (fr) fr.checked = false;
          if (fz) fz.checked = false;
        }
      });

      // Show controls now that the style + track are ready.
      const controls = document.getElementById("map-controls");
      controls.classList.remove("hidden");
      document.getElementById("theme-select").addEventListener("change", (e) => applyTheme(e.target.value));
      document.getElementById("color-select").addEventListener("change", (e) => {
        currentColorMode = e.target.value;
        syncTraceModeOptions();
        applyTrace();
      });
      document.getElementById("trace-mode-select").addEventListener("change", (e) => {
        currentTraceMode = e.target.value;
        applyTrace();
      });
      const followPanEl = document.getElementById("follow-pan");
      const followRotateEl = document.getElementById("follow-rotate");
      if (followPanEl) {
        followPanEl.checked = followPan;
        followPanEl.addEventListener("change", (e) => {
          followPan = e.target.checked;
          if (followPan && riderMarker) {
            map.easeTo({ center: riderMarker.getLngLat(), duration: 400 });
          }
        });
      }
      if (followRotateEl) {
        followRotateEl.checked = followRotate;
        followRotateEl.addEventListener("change", (e) => {
          followRotate = e.target.checked;
        });
      }
      const followZoomEl = document.getElementById("follow-zoom");
      if (followZoomEl) {
        followZoomEl.checked = followZoom;
        followZoomEl.addEventListener("change", (e) => {
          followZoom = e.target.checked;
          // Seed smoother from current zoom so enabling doesn't jump.
          if (followZoom) smoothedZoom = map.getZoom();
        });
      }
      const toggleBtn = document.getElementById("map-controls-toggle");
      if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
          controls.classList.toggle("collapsed");
        });
      }
      syncColorSelectOptions();
      syncTraceModeOptions();
      applyTrace();

      updateUI();
    });
  } else {
    document.getElementById("map").innerHTML =
      '<div style="padding:40px;color:#888;text-align:center;">No GPS data for this trip.</div>';
  }

  // ---------- Charts ----------
  // render: "area" (default, filled), "line" (line only), "current" (filled to
  // the 0 A baseline, green below it for regen). dp = decimal places shown.
  const REGEN_COLOR = "#00e676";
  // unitKind selects the UNITS converter used when displaying min/value/max.
  // Internal chart drawing always uses raw metric values — only the readout
  // changes — so axis scaling is independent of the locale. The unit string
  // is appended to the live value (min/max stay unit-less for compactness).
  const CHART_CONFIG = {
    speed:    { color: "#00e5ff", idx: SPD,     label: "Speed",    dp: 1, unitKind: "speed" },
    pwm:      { color: "#ff4081", idx: PWM,     label: "PWM",      dp: 1, unit: "%" },
    power:    { color: "#7c4dff", idx: POWER,   label: "Power",    dp: 0, unit: "W" },
    current:  { color: "#ffd740", idx: CURRENT, label: "Current",  dp: 1, render: "current", unit: "A" },
    battery:  { color: "#69f0ae", idx: BATT,    label: "Battery",  dp: 0, unit: "%" },
    voltage:  { color: "#ff5252", idx: VOLT,    label: "Voltage",  dp: 1, unit: "V" },
    temp:     { color: "#ffa000", idx: TEMP,    label: "Temp",     dp: 1, render: "line", unitKind: "temp" },
    altitude: { color: "#ce93d8", idx: ALT,     label: "Altitude", dp: 0, unitKind: "alt" },
  };
  function chartUnit(cfg) {
    if (cfg.unitKind === "speed") return UNITS.speedUnit;
    if (cfg.unitKind === "temp")  return UNITS.tempUnit;
    if (cfg.unitKind === "alt")   return UNITS.altUnit;
    return cfg.unit || "";
  }

  // PWM / Current / Power only exist on some wheels - hide a chart when the
  // trip carries no data for it (incl. legacy cached tracks without the column).
  const OPTIONAL_CHARTS = new Set(["pwm", "current", "power"]);
  function chartHasData(idx) {
    for (let i = 0; i < ts.length; i++) {
      const v = ts[i][idx];
      if (typeof v === "number" && v !== 0) return true;
    }
    return false;
  }

  const hasGpsSpeed = chartHasData(GPSSPD);

  function seriesMinMax(idx) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < ts.length; i++) {
      const v = ts[i][idx];
      if (typeof v !== "number") continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return isFinite(mn) ? { min: mn, max: mx } : { min: 0, max: 0 };
  }

  // ---- Collapsible chart headers (label + min / value / max) ----
  function makeEl(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function makeStatline() {
    const line = makeEl("div", "ch-statline");
    const min = makeEl("span", "ch-min");
    const val = makeEl("span", "ch-val", "\u2014");
    const max = makeEl("span", "ch-max");
    line.append(min, val, max);
    return { line, min, val, max };
  }

  function buildChartHeader(c) {
    const head = makeEl("div", "chart-head");
    head.appendChild(makeEl("span", "ch-caret", "\u25be"));

    if (c.extra) {
      // Speed with GPS - triple header: Speed row, GPS row, difference row.
      head.classList.add("chart-head-speed");
      const rows = makeEl("div", "ch-speedrows");
      const mkRow = (text, sub, color) => {
        const row = makeEl("div", "ch-row");
        const lbl = makeEl("span", "ch-label" + (sub ? " ch-sub" : ""), text);
        if (color) lbl.style.color = color;
        const s = makeStatline();
        row.append(lbl, s.line);
        rows.appendChild(row);
        return s;
      };
      // With GPS as a companion, the wheel's own dial speed is "Wheel Speed".
      const sWheel = mkRow("Wheel Speed", false, c.cfg.color);
      const sGps = mkRow("GPS Speed", true, c.extra.color);
      const rDiff = makeEl("div", "ch-row ch-row-diff");
      rDiff.appendChild(makeEl("span", "ch-label", ""));
      const sDiff = makeStatline();
      sDiff.val.textContent = "";
      rDiff.appendChild(sDiff.line);
      rows.appendChild(rDiff);
      head.appendChild(rows);
      c.elMin = sWheel.min; c.elVal = sWheel.val; c.elMax = sWheel.max;
      c.elGpsMin = sGps.min; c.elGpsVal = sGps.val; c.elGpsMax = sGps.max;
      c.elDiff = sDiff.val;
    } else {
      const lbl = makeEl("span", "ch-label", c.cfg.label);
      lbl.style.color = c.cfg.color;
      const s = makeStatline();
      head.append(lbl, s.line);
      c.elMin = s.min; c.elVal = s.val; c.elMax = s.max;
    }

    head.addEventListener("click", () => toggleCollapse(c));
    c.head = head;
    c.block.insertBefore(head, c.block.firstChild);
  }

  function toggleCollapse(c) {
    c.collapsed = !c.collapsed;
    c.block.classList.toggle("collapsed", c.collapsed);
    if (!c.collapsed) {
      // Re-fit the canvas once the body is laid out again, then redraw.
      requestAnimationFrame(() => {
        resizeChart(c);
        drawChart(c, currentSampleIdx + sampleFraction);
      });
    }
  }

  const chartBlocks = document.querySelectorAll(".chart-block");
  const charts = [];
  chartBlocks.forEach(block => {
    const key = block.dataset.key;
    const cfg = CHART_CONFIG[key];
    if (!cfg) return;
    if (OPTIONAL_CHARTS.has(key) && !chartHasData(cfg.idx)) {
      block.classList.add("hidden");
      return;
    }
    const c = { key, cfg, block, canvas: block.querySelector("canvas"), collapsed: false };
    // The speed chart carries GPS speed as a dashed companion on the same axis.
    if (key === "speed" && hasGpsSpeed) c.extra = { idx: GPSSPD, color: GPS_COLOR };
    buildChartHeader(c);

    // Static trip min / max shown either side of the live value. Values that
    // carry a unitKind get the locale-appropriate conversion.
    const mm = seriesMinMax(cfg.idx);
    c.elMin.textContent = fmtFixed(convertByKind(cfg.unitKind, mm.min), cfg.dp);
    c.elMax.textContent = fmtFixed(convertByKind(cfg.unitKind, mm.max), cfg.dp);
    if (c.extra) {
      const gm = seriesMinMax(c.extra.idx);
      c.elGpsMin.textContent = fmtFixed(convertByKind(cfg.unitKind, gm.min), cfg.dp);
      c.elGpsMax.textContent = fmtFixed(convertByKind(cfg.unitKind, gm.max), cfg.dp);
    }
    charts.push(c);
  });

  // ---------- G-Force instant gauge ----------
  // G-Force is an instantaneous IMU reading, shown as a live dot with a fading
  // motion trail in the lateral (X) / longitudinal (Y) plane next to Speed and
  // Battery. A row reads 0 when the IMU missed that sample: isolated misses are
  // interpolated so the dot glides; a sustained drop-out blanks the dot.
  const GF_RGB = "224,64,251";
  const gforceGauge = (function setupGforceGauge() {
    if (!chartHasData(GFORCE)) return null;
    const present = new Uint8Array(ts.length).fill(1);
    let i = 0;
    while (i < ts.length) {
      if (ts[i][GFORCE] !== 0) { i++; continue; }
      let j = i;
      while (j < ts.length && ts[j][GFORCE] === 0) j++;
      if (j - i >= 4) {
        for (let k = i; k < j; k++) present[k] = 0;            // sustained drop-out
      } else {
        const lo = i - 1, hi = j;                              // isolated miss - interpolate
        for (const col of [GFORCEX, GFORCEY]) {
          const a = lo >= 0 ? ts[lo][col] : (hi < ts.length ? ts[hi][col] : 0);
          const b = hi < ts.length ? ts[hi][col] : a;
          for (let k = i; k < j; k++) ts[k][col] = a + (b - a) * ((k - lo) / (hi - lo));
        }
      }
      i = j;
    }
    // The outer ring maps to the trip's peak planar g, with a little headroom.
    let gMax = 0.2;
    for (let k = 0; k < ts.length; k++) {
      if (!present[k]) continue;
      const m = Math.hypot(ts[k][GFORCEX], ts[k][GFORCEY]);
      if (m > gMax) gMax = m;
    }
    const el = document.getElementById("gforce-gauge");
    el.classList.remove("hidden");
    return {
      present, gMax: gMax * 1.12, el,
      canvas: document.getElementById("gforce-canvas"),
      value: document.getElementById("gforce-value"),
    };
  })();

  function resizeGforce() {
    if (!gforceGauge) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = gforceGauge.canvas.getBoundingClientRect();
    if (rect.width < 2) return;
    gforceGauge.canvas.width = Math.round(rect.width * dpr);
    gforceGauge.canvas.height = Math.round(rect.height * dpr);
  }

  // Redraws the G-Force gauge: rings, a fading trail of recent samples, live dot.
  function updateGforceGauge() {
    if (!gforceGauge) return;
    const g = gforceGauge;
    const cv = g.canvas, ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    if (W < 2 || H < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) / 2 - 3 * dpr;
    ctx.clearRect(0, 0, W, H);

    // Reference rings + axes.
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath(); ctx.arc(cx, cy, R / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.beginPath();
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.stroke();

    const cur = currentSampleIdx;
    if (g.present[cur] === 0) {
      g.el.classList.add("gf-nodata");
      g.value.textContent = "\u2014";
      return;
    }
    g.el.classList.remove("gf-nodata");

    const toXY = (gx, gy) => {
      let nx = gx / g.gMax, ny = gy / g.gMax;
      const len = Math.hypot(nx, ny);
      if (len > 1) { nx /= len; ny /= len; }
      return [cx + nx * R, cy - ny * R];          // +Y (forward) points up
    };

    // Trail: a long fading curve through the most recent samples. Quadratic
    // segments tied through midpoints give a continuous, smooth curve instead
    // of jagged polyline; alpha rises slowly so older samples stay visible.
    const N = 48;
    const pts = [];
    for (let i = Math.max(0, cur - N); i <= cur; i++) {
      if (g.present[i] === 0) { pts.length = 0; continue; }   // a gap breaks the trail
      pts.push(toXY(ts[i][GFORCEX], ts[i][GFORCEY]));
    }
    const hx = sampleAt(GFORCEX), hy = sampleAt(GFORCEY);
    const head = toXY(hx, hy);
    pts.push(head);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (pts.length >= 2) {
      // Precompute midpoints between consecutive vertices — each curve segment
      // goes from one midpoint to the next, passing through the data point as
      // the quadratic control. End-caps anchor to the first/last data points.
      const mid = [];
      for (let i = 0; i < pts.length - 1; i++) {
        mid.push([(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]);
      }
      const total = pts.length - 1;
      for (let i = 0; i < total; i++) {
        const t = (i + 1) / total;                            // 0 oldest -> 1 newest
        // Power < 1 makes the fade slower at the tail so old samples linger.
        const alpha = 0.03 + 0.55 * Math.pow(t, 0.75);
        ctx.strokeStyle = "rgba(" + GF_RGB + "," + alpha.toFixed(3) + ")";
        ctx.lineWidth = 0.5 * dpr + 2.6 * dpr * t;
        ctx.beginPath();
        if (i === 0) ctx.moveTo(pts[0][0], pts[0][1]);
        else ctx.moveTo(mid[i - 1][0], mid[i - 1][1]);
        if (i === total - 1) {
          ctx.quadraticCurveTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        } else {
          ctx.quadraticCurveTo(pts[i][0], pts[i][1], mid[i][0], mid[i][1]);
        }
        ctx.stroke();
      }
    }

    // Live dot, glowing.
    ctx.shadowColor = "rgba(" + GF_RGB + ",0.9)";
    ctx.shadowBlur = 6 * dpr;
    ctx.fillStyle = "#e040fb";
    ctx.beginPath(); ctx.arc(head[0], head[1], 3.6 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.1 * dpr;
    ctx.beginPath(); ctx.arc(head[0], head[1], 3.6 * dpr, 0, Math.PI * 2); ctx.stroke();

    g.value.textContent = Math.hypot(hx, hy).toFixed(2);
  }

  function resizeChart(c) {
    if (c.collapsed) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    c.canvas.width = Math.round(rect.width * dpr);
    c.canvas.height = Math.round(rect.height * dpr);
  }

  function resizeCharts() {
    charts.forEach(resizeChart);
    resizeGforce();
    drawAllCharts();
    updateGforceGauge();
  }

  function drawAllCharts() {
    charts.forEach((c) => { if (!c.collapsed) drawChart(c); });
  }

  // 2-colour filled current chart: amber above the 0 A baseline, green below
  // it (regen). The baseline is a faint reference line.
  function drawCurrentChart(ctx, c, n, px, py, dpr) {
    const idx = c.cfg.idx;
    const zeroY = py(0);
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const areaPath = () => {
      ctx.beginPath();
      ctx.moveTo(px(0), zeroY);
      for (let i = 0; i < n; i++) ctx.lineTo(px(i), py(ts[i][idx]));
      ctx.lineTo(px(n - 1), zeroY);
      ctx.closePath();
    };
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, zeroY); ctx.clip();
    areaPath(); ctx.fillStyle = c.cfg.color + "44"; ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, zeroY, W, H - zeroY); ctx.clip();
    areaPath(); ctx.fillStyle = REGEN_COLOR + "44"; ctx.fill();
    ctx.restore();
    // 0 A baseline
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(px(0), zeroY); ctx.lineTo(px(n - 1), zeroY); ctx.stroke();
    // line, coloured per segment by sign. Where a segment crosses 0 the line
    // is split at the zero point so green never spills into the positive side
    // and vice-versa.
    ctx.lineWidth = 1.6 * dpr;
    ctx.lineJoin = "round";
    const zeroYline = py(0);
    for (let i = 1; i < n; i++) {
      const a = ts[i - 1][idx], b = ts[i][idx];
      const x0 = px(i - 1), y0 = py(a);
      const x1 = px(i), y1 = py(b);
      if ((a < 0) !== (b < 0) && a !== b) {
        const t = -a / (b - a);                 // fraction along the segment where v = 0
        const xz = x0 + t * (x1 - x0);
        ctx.strokeStyle = a < 0 ? REGEN_COLOR : c.cfg.color;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(xz, zeroYline); ctx.stroke();
        ctx.strokeStyle = b < 0 ? REGEN_COLOR : c.cfg.color;
        ctx.beginPath(); ctx.moveTo(xz, zeroYline); ctx.lineTo(x1, y1); ctx.stroke();
      } else {
        const sign = a !== 0 ? a : b;
        ctx.strokeStyle = sign < 0 ? REGEN_COLOR : c.cfg.color;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }
  }

  function drawChart(c, fracIdxArg) {
    if (c.collapsed) return;
    const ctx = c.canvas.getContext("2d");
    const w = c.canvas.width, h = c.canvas.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);
    if (w < 2 || h < 2) return;

    const idx = c.cfg.idx;
    const n = ts.length;
    const render = c.cfg.render || "area";

    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = ts[i][idx];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
      // Fold the GPS-speed overlay into the speed chart's scale so both lines
      // share one axis and the gap between them reads off directly.
      if (c.extra) {
        const e = ts[i][c.extra.idx];
        if (typeof e === "number") { if (e < minV) minV = e; if (e > maxV) maxV = e; }
      }
    }
    if (!isFinite(minV)) { minV = 0; maxV = 1; }
    // The current chart always spans 0 so the regen / draw split stays visible.
    if (render === "current") { if (minV > 0) minV = 0; if (maxV < 0) maxV = 0; }
    if (minV === maxV) { maxV = minV + 1; }
    // Pad a bit
    const range = maxV - minV;
    minV -= range * 0.08;
    maxV += range * 0.08;

    const pad = 4;
    const px = (i) => pad + (i / (n - 1)) * (w - pad * 2);
    const py = (v) => h - pad - ((v - minV) / (maxV - minV)) * (h - pad * 2);

    if (render === "current") {
      drawCurrentChart(ctx, c, n, px, py, dpr);
    } else {
      if (render !== "line") {
        // Filled area under the line.
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, c.cfg.color + "55");
        grad.addColorStop(1, c.cfg.color + "00");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(px(0), h);
        for (let i = 0; i < n; i++) ctx.lineTo(px(i), py(ts[i][idx]));
        ctx.lineTo(px(n - 1), h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = c.cfg.color;
      ctx.lineWidth = 1.6 * dpr;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = px(i), y = py(ts[i][idx]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // GPS-speed companion line - dashed, no fill, on the shared axis.
    if (c.extra) {
      ctx.save();
      ctx.strokeStyle = c.extra.color;
      ctx.lineWidth = 1.4 * dpr;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < n; k++) {
        const v = ts[k][c.extra.idx];
        if (typeof v !== "number") { started = false; continue; }
        const x = px(k), y = py(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Cached for cursor drawing
    c._px = px; c._py = py;

    if (currentSampleIdx >= 0) drawCursor(c, fracIdxArg != null ? fracIdxArg : currentSampleIdx);
  }

  function drawCursor(c, fracIdx) {
    const ctx = c.canvas.getContext("2d");
    if (!c._px) return;
    const dpr = window.devicePixelRatio || 1;
    const i0 = Math.floor(fracIdx);
    const i1 = Math.min(ts.length - 1, i0 + 1);
    const f = fracIdx - i0;
    const x = c._px(fracIdx);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 160, 0, 0.7)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, c.canvas.height);
    ctx.stroke();
    // Main-series dot at the cursor (green when the current chart is in regen).
    const v = ts[i0][c.cfg.idx] + (ts[i1][c.cfg.idx] - ts[i0][c.cfg.idx]) * f;
    ctx.fillStyle = (c.cfg.render === "current" && v < 0) ? REGEN_COLOR : c.cfg.color;
    ctx.beginPath();
    ctx.arc(x, c._py(v), 3 * dpr, 0, Math.PI * 2);
    ctx.fill();
    // GPS-speed overlay dot.
    if (c.extra) {
      const g0 = ts[i0][c.extra.idx], g1 = ts[i1][c.extra.idx];
      if (typeof g0 === "number" && typeof g1 === "number") {
        ctx.fillStyle = c.extra.color;
        ctx.beginPath();
        ctx.arc(x, c._py(g0 + (g1 - g0) * f), 3 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Floating readout for the wheel-vs-GPS speed differential on hover.
  const chartTip = document.createElement("div");
  chartTip.id = "chart-tip";
  chartTip.className = "hidden";
  document.body.appendChild(chartTip);

  // Place a floating tooltip near (mx, my), flipping or clamping so it always
  // stays inside the viewport rather than getting cut off at the edge.
  function positionTooltip(el, mx, my) {
    const w = el.offsetWidth, h = el.offsetHeight;
    const W = window.innerWidth, H = window.innerHeight;
    const m = 6, gap = 16;
    let left = mx + gap;
    let top  = my + gap;
    if (left + w + m > W) left = mx - w - gap;
    if (top  + h + m > H) top  = my - h - gap;
    if (left < m) left = m;
    if (top  < m) top  = m;
    el.style.left = left + "px";
    el.style.top  = top + "px";
  }

  function sampleFromClientX(canvas, clientX) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(ratio * (ts.length - 1));
  }

  // Chart drag/scrub interaction
  charts.forEach(c => {
    let dragging = false;
    const onMove = (clientX) => {
      const t = ts[sampleFromClientX(c.canvas, clientX)][SEC] - t0;
      setCurrentTime(t);
    };
    const onWindowMove = e => { if (dragging) onMove(e.clientX); };
    const onWindowUp = () => { dragging = false; };
    c.canvas.addEventListener("mousedown", e => {
      dragging = true;
      onMove(e.clientX);
      e.preventDefault();
    });
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);

    // Speed chart only: hovering reveals the wheel-vs-GPS differential at
    // that sample without disturbing playback.
    if (c.extra) {
      c.canvas.addEventListener("mousemove", e => {
        const s = sampleFromClientX(c.canvas, e.clientX);
        const row = ts[s];
        const wheel = row[SPD];
        const gps = row[c.extra.idx];
        if (typeof gps !== "number") { chartTip.classList.add("hidden"); return; }
        const wheelD = UNITS.speed(wheel), gpsD = UNITS.speed(gps);
        const diff = wheelD - gpsD;
        const sign = diff >= 0 ? "+" : "−";
        chartTip.innerHTML =
          '<b>' + fmtTime(row[SEC] - t0) + '</b>' +
          '<span class="tip-row"><i style="background:#00e5ff"></i>Wheel speed <b>' + wheelD.toFixed(1) + '</b></span>' +
          '<span class="tip-row"><i style="background:' + GPS_COLOR + '"></i>GPS speed <b>' + gpsD.toFixed(1) + '</b></span>' +
          '<span class="tip-diff">Δ ' + sign + Math.abs(diff).toFixed(1) + ' ' + UNITS.speedUnit + '</span>';
        chartTip.classList.remove("hidden");
        positionTooltip(chartTip, e.clientX, e.clientY);
      });
      c.canvas.addEventListener("mouseleave", () => chartTip.classList.add("hidden"));
    }
  });

  // ---------- Playback state ----------
  let currentTime = 0;   // seconds from start
  let currentSampleIdx = 0;
  let playing = false;
  let lastFrame = 0;

  const scrub = document.getElementById("scrub");
  const playBtn = document.getElementById("play-btn");
  const speedSelect = document.getElementById("speed-select");

  // Pick a sensible default speed so the trip plays back at a comfortable pace.
  function autoPlaySpeed(dur) {
    if (dur <= 1800) return 16;   // ≤ 30 min
    if (dur <= 3600) return 32;   // ≤ 1 h
    if (dur <= 7200) return 64;   // ≤ 2 h
    return 128;                   // > 2 h
  }
  let playSpeed = autoPlaySpeed(duration);
  // Sync the <select> to the chosen default.
  speedSelect.value = String(playSpeed);

  function setPlayingState(next) {
    playing = next;
    playBtn.textContent = playing ? "\u2759\u2759" : "\u25b6";
    playBtn.classList.toggle("playing", playing);
    const themeSel = document.getElementById("theme-select");
    if (themeSel) {
      themeSel.disabled = playing;
      themeSel.title = playing ? "Pause to change map style" : "";
    }
  }

  playBtn.addEventListener("click", () => {
    setPlayingState(!playing);
    lastFrame = performance.now();
    if (playing && currentTime >= duration) {
      setCurrentTime(0);
    }
    if (playing) requestAnimationFrame(loop);
  });

  scrub.addEventListener("input", e => {
    const t = (e.target.value / 1000) * duration;
    setCurrentTime(t);
  });

  speedSelect.addEventListener("change", e => {
    playSpeed = parseFloat(e.target.value);
  });

  let sampleFraction = 0; // 0..1 between currentSampleIdx and currentSampleIdx+1

  function setCurrentTime(t) {
    currentTime = Math.max(0, Math.min(duration, t));
    // Find lower-bound sample (largest idx where ts[idx][SEC]-t0 <= currentTime)
    const target = t0 + currentTime;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid][SEC] <= target) lo = mid; else hi = mid - 1;
    }
    currentSampleIdx = lo;
    if (currentSampleIdx < ts.length - 1) {
      const a = ts[currentSampleIdx][SEC];
      const b = ts[currentSampleIdx + 1][SEC];
      sampleFraction = b > a ? Math.max(0, Math.min(1, (target - a) / (b - a))) : 0;
    } else {
      sampleFraction = 0;
    }
    updateUI();
  }

  function lerp(a, b, f) { return a + (b - a) * f; }
  function sampleAt(col) {
    const r0 = ts[currentSampleIdx];
    const r1 = currentSampleIdx < ts.length - 1 ? ts[currentSampleIdx + 1] : r0;
    return lerp(r0[col], r1[col], sampleFraction);
  }

  function updateUI() {
    // Dashboard (interpolated between adjacent samples)
    const speed = sampleAt(SPD);
    const maxSpeed = Math.max(track.stats?.maxSpeed || 60, 60);
    document.getElementById("speedo-value").textContent = UNITS.speed(speed).toFixed(1);
    const ratio = Math.min(1, speed / maxSpeed);
    document.getElementById("speedo-fill").style.strokeDashoffset = (157 * (1 - ratio)).toFixed(1);
    const angle = -90 + ratio * 180;
    document.getElementById("speedo-needle").style.transform = "rotate(" + angle + "deg)";

    const batt = sampleAt(BATT);
    document.getElementById("battery-value").textContent = batt.toFixed(0) + "%";
    const bf = document.getElementById("battery-fill");
    bf.style.width = Math.max(0, Math.min(100, batt)) + "%";
    bf.classList.toggle("low", batt < 20);

    const cumNow = currentSampleIdx < cumKm.length - 1
      ? lerp(cumKm[currentSampleIdx], cumKm[currentSampleIdx + 1], sampleFraction)
      : cumKm[currentSampleIdx];
    document.getElementById("odo-value").textContent = UNITS.dist(cumNow).toFixed(2);
    document.getElementById("volt-value").textContent = sampleAt(VOLT).toFixed(1);
    document.getElementById("temp-value").textContent = UNITS.temp(sampleAt(TEMP)).toFixed(1);
    document.getElementById("alt-value").textContent = UNITS.alt(sampleAt(ALT)).toFixed(0);
    document.getElementById("clock-value").textContent = fmtTime(currentTime);
    updateGforceGauge();

    // Scrub
    if (document.activeElement !== scrub) {
      scrub.value = duration > 0 ? (currentTime / duration) * 1000 : 0;
    }

    // Charts: refresh each header's live value (and the Speed difference row),
    // then redraw the canvas of every expanded block.
    const fracIdx = currentSampleIdx + sampleFraction;
    charts.forEach(c => {
      const dp = c.cfg.dp;
      const kind = c.cfg.unitKind;
      const unit = chartUnit(c.cfg);
      const unitSpan = unit ? ' <span class="ch-unit">' + unit + '</span>' : '';
      const val = sampleAt(c.cfg.idx);
      c.elVal.innerHTML = fmtFixed(convertByKind(kind, val), dp) + unitSpan;
      if (c.cfg.render === "current") {
        c.elVal.style.color = val < 0 ? REGEN_COLOR : "#fff";
      }
      if (c.extra) {
        const gps = sampleAt(c.extra.idx);
        c.elGpsVal.innerHTML = fmtFixed(convertByKind(kind, gps), dp) + unitSpan;
        // The difference is shown in display units too — both lines are on the
        // same axis so the delta is meaningful either way.
        const diff = convertByKind(kind, val) - convertByKind(kind, gps);
        c.elDiff.textContent = "Δ " + (diff >= 0 ? "+" : "−") + Math.abs(diff).toFixed(dp) + " " + unit;
      }
      if (!c.collapsed) drawChart(c, fracIdx);
    });

    // Map marker + traveled line (marker lerped between adjacent coords)
    if (map && riderMarker && map.isStyleLoaded() && map.getSource("traveled")) {
      if (coords.length > 1) {
        const fracRoute = (currentSampleIdx + sampleFraction) / Math.max(1, ts.length - 1) * (coords.length - 1);
        const routeIdx = Math.floor(fracRoute);
        const routeFrac = fracRoute - routeIdx;
        currentRouteIdx = Math.max(0, Math.min(coords.length - 1, routeIdx));
        const a = coords[currentRouteIdx];
        const b = coords[Math.min(coords.length - 1, currentRouteIdx + 1)];
        const markerPos = [lerp(a[0], b[0], routeFrac), lerp(a[1], b[1], routeFrac)];
        riderMarker.setLngLat(markerPos);

        // Trail ends exactly on coords[currentRouteIdx] — no interpolated marker
        // point — so the gradient's line-progress matches the geometry and the
        // colours stay pinned to the ground instead of crawling each frame.
        const traveled = coords.slice(0, currentRouteIdx + 1);
        if (traveled.length >= 2) {
          map.getSource("traveled").setData({
            type: "Feature", geometry: { type: "LineString", coordinates: traveled }
          });

          updateTraceGradient();
        }
        if ((followPan || followRotate || followZoom) && playing) {
          const nowMs = performance.now();
          if (nowMs - lastFollowAt > 250) {
            lastFollowAt = nowMs;
            const opts = { duration: 400, easing: (t) => t * t * (3 - 2 * t) };
            if (followPan) opts.center = markerPos;
            if (followRotate) {
              const target = computeBearingAt(currentRouteIdx);
              const sm = stepSmoothBearing(target);
              if (sm !== null) opts.bearing = sm;
            }
            if (followZoom) {
              const speedNow = sampleAt(SPD);
              opts.zoom = stepSmoothZoom(targetZoomForSpeed(speedNow));
            }
            if (opts.center || opts.bearing !== undefined || opts.zoom !== undefined) map.easeTo(opts);
          }
        }
      }
    }
  }

  function loop(now) {
    if (!playing) return;
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    let nt = currentTime + dt * playSpeed;
    if (nt >= duration) {
      nt = duration;
      setPlayingState(false);
    }
    setCurrentTime(nt);
    if (playing) requestAnimationFrame(loop);
  }

  // ---------- Init ----------
  window.addEventListener("resize", resizeCharts);
  // Wait a frame so layout settles, then size canvases and start auto-play.
  requestAnimationFrame(() => {
    resizeCharts();
    setCurrentTime(0);
    // Auto-play on load.
    setPlayingState(true);
    lastFrame = performance.now();
    requestAnimationFrame(loop);
  });
})();
