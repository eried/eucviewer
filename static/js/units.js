// Units: the one place the viewer decides between km and miles, °C and °F,
// metres and feet, and converts between them. Loaded before each page's own
// script; they all read window.EucUnits.UNITS. Four pages used to carry
// their own copy of this, with a comment asking to keep them in sync.
//
// Three switches, the same three eucstats.ried.no offers, each on its own:
//   distance     km and km/h, or mi and mph
//   temperature  °C, or °F
//   altitude     m, or ft
// One imperial flag used to hand British riders Fahrenheit and feet they
// never use, and tying altitude to either of the others is wrong for
// somebody. Nothing downstream may assume one flag from another.
//
// A choice is written "<distance>-<temperature>-<altitude>", e.g. km-c-m,
// mi-c-m, mi-f-ft. Still read: the two-part form (km-c, mi-f), where
// altitude went with temperature, and the profile names before that
// (metric, imperial, road).
//
// Resolution order: ?units= URL param, the cookie shared with eucstats, the
// cogwheel's localStorage key, then the timezone.
//
// The default follows where the rider is, not the language the browser is
// set to: English Windows everywhere sends en-US, so language served miles
// to all of Europe. The timezone is OS-set from the actual location and is
// the strongest signal there is without geolocation. Anything unrecognised
// stays metric, so nobody gets miles by accident.
//
// The cookie is what lets a choice made here follow the rider to eucstats
// and back. localStorage is per site; a cookie on the parent domain is
// readable by both. Its name and values must match eucstats (web/public.py).
(function () {
  "use strict";

  const STORAGE_KEY = "eucviewer-units";
  const COOKIE = "euc_units";
  const LEGACY = { metric: "km-c-m", imperial: "mi-f-ft", road: "mi-c-m" };
  // Anything readable becomes one of the eight codes, anything else null.
  function normalize(v) {
    if (typeof v !== "string") return null;
    v = v.trim().toLowerCase();
    if (LEGACY[v]) return LEGACY[v];
    // Two parts: from before altitude had a switch, when it went with °F.
    if (/^(km|mi)-(c|f)$/.test(v)) return v + (v.slice(-1) === "f" ? "-ft" : "-m");
    return /^(km|mi)-(c|f)-(m|ft)$/.test(v) ? v : null;
  }
  const flagsOf = (code) => {
    const part = code.split("-");
    return { miles: part[0] === "mi", fahrenheit: part[1] === "f", feet: part[2] === "ft" };
  };
  const codeOf = (f) => (f.miles ? "mi" : "km") + "-" + (f.fahrenheit ? "f" : "c") + "-" + (f.feet ? "ft" : "m");

  const IMPERIAL_TZ_RE = new RegExp("^(?:" +
    "America/(?:Adak|Anchorage|Boise|Chicago|Denver|Detroit|Indiana/[^/]+|Juneau|Kentucky/[^/]+|Los_Angeles|Menominee|Metlakatla|New_York|Nome|North_Dakota/[^/]+|Phoenix|Puerto_Rico|Sitka|St_Thomas|Yakutat)" +
    "|Pacific/(?:Honolulu|Pago_Pago|Guam|Saipan|Midway|Wake)" +
    "|Africa/Monrovia" +
    ")$");
  const ROAD_TZ_RE = /^(?:Europe\/(?:London|Belfast|Jersey|Guernsey|Isle_of_Man)|Asia\/(?:Yangon|Rangoon))$/;

  function profileForTimezone(tz) {
    if (IMPERIAL_TZ_RE.test(tz)) return "mi-f-ft";
    if (ROAD_TZ_RE.test(tz)) return "mi-c-m";
    return "km-c-m";
  }

  function readCookie() {
    try {
      const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_) { return null; }
  }
  function writeCookie(v) {
    try {
      // On ried.no the cookie goes on the parent domain, where eucstats can
      // read it. Anywhere else (localhost, a fork on github.io) it stays with
      // the host, which is all it can do.
      const shared = /(^|\.)ried\.no$/.test(location.hostname) ? "; domain=ried.no" : "";
      document.cookie = COOKIE + "=" + encodeURIComponent(v) + shared +
        "; path=/; max-age=31536000; samesite=lax";
    } catch (_) {}
  }

  function detect() {
    try {
      const force = normalize(new URLSearchParams(location.search).get("units"));
      if (force) return force;
    } catch (_) {}
    // The cookie before localStorage: it is the newer of the two whenever
    // the choice was last made on the other site.
    const shared = normalize(readCookie());
    if (shared) return shared;
    try {
      const stored = normalize(localStorage.getItem(STORAGE_KEY));
      if (stored) return stored;
    } catch (_) {}
    try {
      return profileForTimezone((Intl.DateTimeFormat().resolvedOptions().timeZone || "").trim());
    } catch (_) {}
    return "km-c-m";
  }

  const MI = 0.621371, FT = 3.28084, MPH_PER_MS = 2.23694;
  const same = (v) => v;

  function build(profile) {
    const p = flagsOf(profile);
    // Climb rate is metres per km unless both of its halves are imperial:
    // "metres per mile" is a unit nobody has ever asked for.
    const ftPerMi = p.miles && p.feet;
    return {
      profile,
      miles: p.miles, fahrenheit: p.fahrenheit, feet: p.feet,
      // All three at once. Kept for the places that only care whether the
      // whole display is imperial.
      imperial: p.miles && p.fahrenheit && p.feet,

      dist:  p.miles ? (km) => km * MI : same,
      speed: p.miles ? (kmh) => kmh * MI : same,
      temp:  p.fahrenheit ? (c) => c * 9 / 5 + 32 : same,
      alt:   p.feet ? (m) => m * FT : same,
      distUnit: p.miles ? "mi" : "km",
      speedUnit: p.miles ? "mph" : "km/h",
      tempUnit: p.fahrenheit ? "°F" : "°C",
      altUnit: p.feet ? "ft" : "m",

      // Back from what is on screen to what is stored.
      distInv:  p.miles ? (mi) => mi / MI : same,
      speedInv: p.miles ? (mph) => mph / MI : same,
      tempInv:  p.fahrenheit ? (f) => (f - 32) * 5 / 9 : same,
      altInv:   p.feet ? (ft) => ft / FT : same,

      // A temperature difference scales by 9/5 but must not get the +32.
      tempDelta: p.fahrenheit ? (c) => c * 9 / 5 : same,

      // m/km <-> ft/mi
      climb:    ftPerMi ? (mPerKm) => mPerKm * FT / MI : same,
      climbInv: ftPerMi ? (ftMi) => ftMi * MI / FT : same,
      climbUnit: ftPerMi ? "ft/mi" : "m/km",

      // m/s <-> mph. Wind follows the road units.
      wind:    p.miles ? (ms) => ms * MPH_PER_MS : same,
      windInv: p.miles ? (mph) => mph / MPH_PER_MS : same,
      windUnit: p.miles ? "mph" : "m/s",
    };
  }

  const profile = detect();

  window.EucUnits = {
    UNITS: build(profile),
    profile,
    profileForTimezone,
    // The cogwheel calls this with the one switch that moved, e.g.
    // { miles: true }, then reloads: UNITS is captured into too many render
    // closures to swap live. A whole code ("mi-c-m") works too.
    set(next) {
      let code;
      if (typeof next === "string") {
        code = normalize(next);
      } else {
        const f = flagsOf(profile);
        ["miles", "fahrenheit", "feet"].forEach((k) => { if (k in next) f[k] = !!next[k]; });
        code = codeOf(f);
      }
      if (!code) return;
      try { localStorage.setItem(STORAGE_KEY, code); } catch (_) {}
      writeCookie(code);
    },
  };
})();
