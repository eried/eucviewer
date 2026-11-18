// Languages: the one place the viewer decides which language to speak and
// looks a string up. Loaded before each page's own script, which reads
// window.EucI18n.t (as `const i18n = window.EucI18n.t`; `t` is taken by a
// hundred loop variables).
//
// The English text is the key: i18n("Upload trips") returns the translation,
// or the English itself when there is none, so a missing entry is never a
// blank. Placeholders are named: i18n("{n} trips", { n: 12 }). The first
// argument must be a plain string literal so tools/i18n_extract.py can find
// it; anything built at run time cannot be translated.
//
// Static markup is marked instead of rewritten:
//   data-i18n                      the element's text
//   data-i18n-html                 the element's markup, tags and all
//   data-i18n-attrs="title alt"    the listed attributes
//
// The list is the one the EUC Planet app ships, plus English (UK), which
// eucstats has too. One dictionary per language
// lives in static/i18n/<code>.js and only the one in use is fetched.
//
// Resolution order: ?lang= URL param, the cookie shared with eucstats, the
// cogwheel's localStorage key, then the browser's language list. Unlike
// units, language is exactly what the browser setting is for.
//
// The cookie is what lets a choice made here follow the rider to eucstats
// and back, the same way units do. Its name and codes must match eucstats
// (web/public.py); a code the other site lacks is ignored there.
(function () {
  "use strict";

  const STORAGE_KEY = "eucviewer-lang";
  const COOKIE = "euc_lang";
  // Bump when any dictionary changes, so nobody keeps a stale one.
  const DICT_VERSION = "6";

  // Native names, never translated.
  const LANGS = {
    "en": "English (US)",
    "en-GB": "English (UK)",
    "bg": "Български",
    "cs": "Čeština",
    "da": "Dansk",
    "de": "Deutsch",
    "el": "Ελληνικά",
    "es": "Español (ES)",
    "es-419": "Español (LA)",
    "fi": "Suomi",
    "fr": "Français",
    "hu": "Magyar",
    "id": "Bahasa Indonesia",
    "it": "Italiano",
    "ja": "日本語",
    "ko": "한국어",
    "nl": "Nederlands",
    "no": "Norsk",
    "pl": "Polski",
    "pt-BR": "Português (BR)",
    "pt-PT": "Português (PT)",
    "ro": "Română",
    "ru": "Русский",
    "sk": "Slovenčina",
    "sv": "Svenska",
    "th": "ไทย",
    "tr": "Türkçe",
    "uk": "Українська",
    "vi": "Tiếng Việt",
    "zh": "中文 (简体)",
    "zh-Hant": "中文 (繁體)",
  };
  const has = (code) => Object.prototype.hasOwnProperty.call(LANGS, code);

  const LATAM = ["419", "MX", "AR", "CO", "CL", "PE", "VE", "EC", "GT", "CU", "BO",
    "DO", "HN", "PY", "SV", "NI", "CR", "PA", "UY", "PR", "US"];
  // Where Portuguese is the European kind. Both lists are the ones the app uses.
  const PT_PT = ["PT", "AO", "MZ", "CV", "GW", "ST", "TL"];
  // A browser tag ("es-MX", "nb", "zh-TW") to one of ours, or null.
  function mapLang(raw) {
    if (!raw) return null;
    const lc = String(raw).toLowerCase();
    const base = lc.split("-")[0];
    const region = (lc.split("-")[1] || "").toUpperCase();
    if (base === "en") return /^(GB|UK|IE|AU|NZ|ZA|IN)$/.test(region) ? "en-GB" : "en";
    if (base === "pt") return PT_PT.indexOf(region) >= 0 ? "pt-PT" : "pt-BR";
    if (base === "zh") return /(^|-)(tw|hk|mo|hant)(-|$)/.test(lc) ? "zh-Hant" : "zh";
    if (base === "nb" || base === "nn" || base === "no") return "no";
    if (base === "in") return "id";
    if (base === "es") return LATAM.indexOf(region) >= 0 ? "es-419" : "es";
    return has(base) ? base : null;
  }
  // A stored or shared code: exact first, then as a browser tag.
  const known = (v) => (typeof v === "string" && has(v) ? v : mapLang(v));

  function readCookie() {
    try {
      const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_) { return null; }
  }
  function writeCookie(v) {
    try {
      const shared = /(^|\.)ried\.no$/.test(location.hostname) ? "; domain=ried.no" : "";
      document.cookie = COOKIE + "=" + encodeURIComponent(v) + shared +
        "; path=/; max-age=31536000; samesite=lax";
    } catch (_) {}
  }

  function detect() {
    try {
      const force = known(new URLSearchParams(location.search).get("lang"));
      if (force) return force;
    } catch (_) {}
    const shared = known(readCookie());
    if (shared) return shared;
    try {
      const stored = known(localStorage.getItem(STORAGE_KEY));
      if (stored) return stored;
    } catch (_) {}
    try {
      const navs = (navigator.languages && navigator.languages.length)
        ? navigator.languages : [navigator.language || "en"];
      for (let i = 0; i < navs.length; i++) {
        const m = mapLang(navs[i]);
        if (m) return m;
      }
    } catch (_) {}
    return "en";
  }

  const lang = detect();
  try { document.documentElement.lang = lang; } catch (_) {}

  function t(en, vars) {
    const dict = window.EUC_I18N_DICT;
    let s = (dict && dict[en]) || en;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
  }

  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // Translate marked static markup under root. The English is kept in the
  // marker the first time through, so a second pass still finds its key.
  function apply(root) {
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      let key = el.getAttribute("data-i18n");
      if (!key) { key = squash(el.textContent); el.setAttribute("data-i18n", key); }
      el.textContent = t(key);
    });
    root.querySelectorAll("[data-i18n-html]").forEach((el) => {
      let key = el.getAttribute("data-i18n-html");
      if (!key) { key = squash(el.innerHTML); el.setAttribute("data-i18n-html", key); }
      el.innerHTML = t(key);
    });
    root.querySelectorAll("[data-i18n-attrs]").forEach((el) => {
      el.getAttribute("data-i18n-attrs").split(/\s+/).forEach((name) => {
        if (!name) return;
        const keep = "data-i18n-en-" + name;
        let key = el.getAttribute(keep);
        if (key == null) { key = el.getAttribute(name) || ""; el.setAttribute(keep, key); }
        if (key) el.setAttribute(name, t(key));
      });
    });
  }

  function set(next) {
    if (!has(next)) return;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
    writeCookie(next);
  }

  // The cogwheel's language list, on any page that has one. Picking a
  // language saves it and reloads: strings are baked into too many rendered
  // nodes to swap live.
  function wirePicker() {
    const sel = document.getElementById("lang-select");
    if (!sel) return;
    Object.keys(LANGS).forEach((code) => {
      const o = document.createElement("option");
      o.value = code;
      o.textContent = LANGS[code];
      sel.appendChild(o);
    });
    sel.value = lang;
    sel.addEventListener("change", () => {
      set(sel.value);
      // A ?lang= left in the address would win over the choice just made.
      try {
        const url = new URL(location.href);
        if (url.searchParams.has("lang")) {
          url.searchParams.delete("lang");
          location.replace(url.toString());
          return;
        }
      } catch (_) {}
      location.reload();
    });
  }

  window.EucI18n = { lang, LANGS, t, apply, mapLang, set };
  wirePicker();

  // The dictionary has to be in before the page script runs its first t().
  // A parser-inserted script is the one way to load a file and block on it
  // without a build step; the second one translates the markup above it.
  if (lang !== "en") {
    try {
      const me = document.currentScript && document.currentScript.src;
      const base = me ? me.replace(/js\/i18n\.js.*$/, "i18n/") : "static/i18n/";
      document.write('<script src="' + base + lang + ".js?v=" + DICT_VERSION + '"><\/script>' +
        "<script>window.EucI18n.apply(document);<\/script>");
    } catch (_) {}
  }
})();
