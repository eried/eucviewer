// Units: the one place the viewer decides between km and miles, °C and °F,
// metres and feet, and converts between them. Loaded before each page's own
// script; they all read window.EucUnits.UNITS. Four pages used to carry
// their own copy of this, with a comment asking to keep them in sync.
//
// Three profiles, the same three eucstats.ried.no uses:
//   metric    km, km/h, °C, m
//   imperial  mi, mph, °F, ft      (US, its territories, Liberia)
//   road      mi, mph, °C, m       (UK, Myanmar: miles on the road, metric
//                                   for everything else)
// One imperial flag handed British riders Fahrenheit and feet they never
// use, so each quantity has its own: miles, fahrenheit, feet.
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
  const PROFILES = {
    metric:   { miles: false, fahrenheit: false, feet: false },
    imperial: { miles: true,  fahrenheit: true,  feet: true },
    road:     { miles: true,  fahrenheit: false, feet: false },
  };
  const valid = (v) => Object.prototype.hasOwnProperty.call(PROFILES, v);

  const IMPERIAL_TZ_RE = new RegExp("^(?:" +
    "America/(?:Adak|Anchorage|Boise|Chicago|Denver|Detroit|Indiana/[^/]+|Juneau|Kentucky/[^/]+|Los_Angeles|Menominee|Metlakatla|New_York|Nome|North_Dakota/[^/]+|Phoenix|Puerto_Rico|Sitka|St_Thomas|Yakutat)" +
    "|Pacific/(?:Honolulu|Pago_Pago|Guam|Saipan|Midway|Wake)" +
    "|Africa/Monrovia" +
    ")$");
  const ROAD_TZ_RE = /^(?:Europe\/(?:London|Belfast|Jersey|Guernsey|Isle_of_Man)|Asia\/(?:Yangon|Rangoon))$/;

  function profileForTimezone(tz) {
    if (IMPERIAL_TZ_RE.test(tz)) return "imperial";
    if (ROAD_TZ_RE.test(tz)) return "road";
    return "metric";
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
      const force = new URLSearchParams(location.search).get("units");
      if (valid(force)) return force;
    } catch (_) {}
    // The cookie before localStorage: it is the newer of the two whenever
    // the choice was last made on the other site.
    const shared = readCookie();
    if (valid(shared)) return shared;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (valid(stored)) return stored;
    } catch (_) {}
    try {
      return profileForTimezone((Intl.DateTimeFormat().resolvedOptions().timeZone || "").trim());
    } catch (_) {}
    return "metric";
  }

  const MI = 0.621371, FT = 3.28084, MPH_PER_MS = 2.23694;
  const same = (v) => v;

  function build(profile) {
    const p = PROFILES[profile];
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
    // The cogwheel calls this, then reloads: UNITS is captured into too
    // many render closures to swap live.
    set(next) {
      if (!valid(next)) return;
      try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
      writeCookie(next);
    },
  };
})();
