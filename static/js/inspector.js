(async function () {
  "use strict";

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

  // Timeseries layout: [sec, speed, voltage, temp, battery, altitude, lat, lon, mileageKm]
  const SEC = 0, SPD = 1, VOLT = 2, TEMP = 3, BATT = 4, ALT = 5, LAT = 6, LON = 7, MILEAGE = 8;
  // Points layout: [lat, lon, speed, alt, volt, temp, battery]
  const P_LAT = 0, P_LON = 1, P_SPD = 2, P_ALT = 3, P_VOLT = 4, P_TEMP = 5, P_BATT = 6;

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
    if (track.stats.distanceKm) subBits.push(track.stats.distanceKm + " km");
    if (track.stats.maxSpeed) subBits.push(track.stats.maxSpeed + " km/h max");
    subBits.push((track.stats.rows || ts.length).toLocaleString() + " samples");
  }
  document.getElementById("trip-subtitle").textContent = subBits.join(" \u00b7 ");
  document.getElementById("odo-total").textContent = totalKm.toFixed(2);
  document.getElementById("clock-total").textContent = fmtTime(duration);

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  // ---------- MapLibre map ----------
  function hasGpsRow(row) {
    return row[LAT] !== 0 && row[LON] !== 0;
  }

  const gpsPoints = ts.filter(hasGpsRow);
  let routePoints = Array.isArray(track.points) ? track.points.filter((p) => p[P_LAT] !== 0 && p[P_LON] !== 0) : [];
  if (routePoints.length < 2) {
    // Fallback for legacy payloads: reconstruct route from timeseries GPS rows.
    routePoints = gpsPoints.map((r) => [r[LAT], r[LON], r[SPD], r[ALT], r[VOLT], r[TEMP], r[BATT]]);
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
    speed:    { pointIdx: P_SPD,  unit: "km/h", invert: false },
    battery:  { pointIdx: P_BATT, unit: "%",    invert: true  },
    voltage:  { pointIdx: P_VOLT, unit: "V",    invert: true  },
    temp:     { pointIdx: P_TEMP, unit: "\u00b0C", invert: false },
    altitude: { pointIdx: P_ALT,  unit: "m",    invert: false }
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
    return { min: minV, max: maxV, invert: cfg.invert, unit: cfg.unit };
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
    const step = Math.max(1, Math.floor((end + 1) / 150));
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
    const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + " " + stats.unit;
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
      syncTraceModeOptions();
      applyTrace();

      updateUI();
    });
  } else {
    document.getElementById("map").innerHTML =
      '<div style="padding:40px;color:#888;text-align:center;">No GPS data for this trip.</div>';
  }

  // ---------- Charts ----------
  const CHART_CONFIG = {
    speed:    { color: "#00e5ff", idx: SPD,  unit: " km/h" },
    voltage:  { color: "#ff5252", idx: VOLT, unit: " V" },
    temp:     { color: "#ffa000", idx: TEMP, unit: " \u00b0C" },
    battery:  { color: "#69f0ae", idx: BATT, unit: " %" },
    altitude: { color: "#ce93d8", idx: ALT,  unit: " m" },
  };

  const chartBlocks = document.querySelectorAll(".chart-block");
  const charts = [];
  chartBlocks.forEach(block => {
    const key = block.dataset.key;
    const cfg = CHART_CONFIG[key];
    const canvas = block.querySelector("canvas");
    const reading = block.querySelector("[data-reading]");
    charts.push({ key, cfg, canvas, reading, block });
  });

  function resizeCharts() {
    const dpr = window.devicePixelRatio || 1;
    charts.forEach(c => {
      const rect = c.canvas.getBoundingClientRect();
      c.canvas.width = Math.max(10, rect.width * dpr);
      c.canvas.height = Math.max(10, rect.height * dpr);
    });
    drawAllCharts();
  }

  function drawAllCharts() {
    charts.forEach(drawChart);
  }

  function drawChart(c) {
    const ctx = c.canvas.getContext("2d");
    const w = c.canvas.width, h = c.canvas.height;
    ctx.clearRect(0, 0, w, h);

    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < ts.length; i++) {
      const v = ts[i][c.cfg.idx];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (minV === maxV) { maxV = minV + 1; }
    // Pad a bit
    const range = maxV - minV;
    minV -= range * 0.08;
    maxV += range * 0.08;

    const pad = 4;
    const px = (i) => pad + (i / (ts.length - 1)) * (w - pad * 2);
    const py = (v) => h - pad - ((v - minV) / (maxV - minV)) * (h - pad * 2);

    // Fill gradient under line
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, c.cfg.color + "55");
    grad.addColorStop(1, c.cfg.color + "00");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(px(0), h);
    for (let i = 0; i < ts.length; i++) ctx.lineTo(px(i), py(ts[i][c.cfg.idx]));
    ctx.lineTo(px(ts.length - 1), h);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = c.cfg.color;
    ctx.lineWidth = 1.6 * (window.devicePixelRatio || 1);
    ctx.beginPath();
    for (let i = 0; i < ts.length; i++) {
      const x = px(i), y = py(ts[i][c.cfg.idx]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Cached for cursor drawing
    c._px = px; c._py = py; c._range = [minV, maxV];

    // Redraw cursor
    if (currentSampleIdx >= 0) drawCursor(c, arguments[1] != null ? arguments[1] : currentSampleIdx);
  }

  function drawCursor(c, fracIdx) {
    const ctx = c.canvas.getContext("2d");
    if (!c._px) return;
    const i0 = Math.floor(fracIdx);
    const i1 = Math.min(ts.length - 1, i0 + 1);
    const f = fracIdx - i0;
    const x = c._px(fracIdx);
    const v = ts[i0][c.cfg.idx] + (ts[i1][c.cfg.idx] - ts[i0][c.cfg.idx]) * f;
    const y = c._py(v);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 160, 0, 0.7)";
    ctx.lineWidth = 1 * (window.devicePixelRatio || 1);
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, c.canvas.height);
    ctx.stroke();
    ctx.fillStyle = "#ffa000";
    ctx.beginPath();
    ctx.arc(x, y, 3 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Chart drag/scrub interaction
  charts.forEach(c => {
    let dragging = false;
    const onMove = (clientX) => {
      const rect = c.canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const sample = Math.round(ratio * (ts.length - 1));
      const t = ts[sample][SEC] - t0;
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
    document.getElementById("speedo-value").textContent = speed.toFixed(1);
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
    document.getElementById("odo-value").textContent = cumNow.toFixed(2);
    document.getElementById("volt-value").textContent = sampleAt(VOLT).toFixed(1);
    document.getElementById("temp-value").textContent = sampleAt(TEMP).toFixed(1);
    document.getElementById("alt-value").textContent = sampleAt(ALT).toFixed(0);
    document.getElementById("clock-value").textContent = fmtTime(currentTime);

    // Scrub
    if (document.activeElement !== scrub) {
      scrub.value = duration > 0 ? (currentTime / duration) * 1000 : 0;
    }

    // Charts: update readings + cursors (cursor uses fractional index for smooth sweep)
    const fracIdx = currentSampleIdx + sampleFraction;
    charts.forEach(c => {
      c.reading.textContent = sampleAt(c.cfg.idx).toFixed(1) + c.cfg.unit;
      drawChart(c, fracIdx);
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

        const traveled = coords.slice(0, currentRouteIdx + 1);
        if (b !== a) traveled.push(markerPos);
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
