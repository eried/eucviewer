#!/usr/bin/env node
// Holds the viewer to what it shares with eucstats and the EUC Planet app:
// languages and their names, which browser tag picks which language, unit
// codes, timezone defaults and the cookies. The rules are a copy of eucstats
// tests/parity_rules.json; change that file only together with the others.
//
//     node tools/parity_check.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.dirname(__dirname);
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "parity_rules.json"), "utf8"));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const problems = [];
const expect = (ok, what) => { if (!ok) problems.push(what); };

// Just enough of a browser for units.js and i18n.js to run and decide.
function load(file, opts) {
  opts = opts || {};
  const store = {};
  const window = {};
  const sandbox = {
    window,
    document: { cookie: opts.cookie || "", documentElement: {}, getElementById: () => null,
      addEventListener() {}, readyState: "complete", write() {}, currentScript: null },
    location: { search: opts.search || "", hostname: "eucviewer.ried.no", href: "https://eucviewer.ried.no/" },
    navigator: { languages: opts.languages || ["en-US"], language: (opts.languages || ["en-US"])[0] },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    URLSearchParams, URL, RegExp,
    Intl: { DateTimeFormat: function () { return { resolvedOptions: () => ({ timeZone: opts.tz || "Europe/Oslo" }) }; } },
  };
  vm.runInNewContext(read(file), sandbox, { filename: file });
  return { window, document: sandbox.document, store };
}

// Languages and their names.
const i18n = load("static/js/i18n.js").window.EucI18n;
const ours = i18n.LANGS;
Object.keys(rules.languages).forEach((code) => {
  expect(ours[code] === rules.languages[code], "language " + code + ": name is " + JSON.stringify(ours[code]) + ", rules say " + JSON.stringify(rules.languages[code]));
  if (code !== "en") expect(fs.existsSync(path.join(ROOT, "static", "i18n", code + ".js")), "language " + code + ": no dictionary file");
});
Object.keys(ours).forEach((code) => expect(code in rules.languages, "language " + code + " is not in the rules"));

// Browser tag to language, as detection does it and as a stored value does.
rules.language_mapping.forEach(([tag, want]) => {
  expect(i18n.mapLang(tag) === want, "browser tag " + tag + " gives " + i18n.mapLang(tag) + ", rules say " + want);
  const viaQuery = load("static/js/i18n.js", { search: "?lang=" + tag }).window.EucI18n.lang;
  expect(viaQuery === want, "?lang=" + tag + " gives " + viaQuery + ", rules say " + want);
});

// The shared cookies: read on the way in, written with the shared domain.
const viaCookie = load("static/js/i18n.js", { cookie: rules.language_cookie + "=de" });
expect(viaCookie.window.EucI18n.lang === "de", "language cookie " + rules.language_cookie + " is not read");
viaCookie.window.EucI18n.set("fr");
expect(new RegExp("^" + rules.language_cookie + "=fr;.*domain=" + rules.cookie_domain.replace(".", "\.")).test(viaCookie.document.cookie),
  "language cookie is not written as " + rules.language_cookie + " on " + rules.cookie_domain);

// Units.
const U = rules.units;
rules.units.codes.forEach((code) => {
  expect(load("static/js/units.js", { search: "?units=" + code }).window.EucUnits.profile === code, "units code " + code + " is not accepted");
  expect(load("static/js/units.js", { cookie: U.cookie + "=" + code }).window.EucUnits.profile === code, "units cookie " + U.cookie + "=" + code + " is not read");
});
Object.keys(U.older_values_still_read).forEach((old) => {
  const got = load("static/js/units.js", { cookie: U.cookie + "=" + old }).window.EucUnits.profile;
  expect(got === U.older_values_still_read[old], "older units value " + old + " reads as " + got + ", rules say " + U.older_values_still_read[old]);
});
Object.keys(U.default_by_timezone).forEach((tz) => {
  const got = load("static/js/units.js", { tz }).window.EucUnits.profile;
  expect(got === U.default_by_timezone[tz], "timezone " + tz + " defaults to " + got + ", rules say " + U.default_by_timezone[tz]);
});
const units = load("static/js/units.js", {});
units.window.EucUnits.set({ miles: true });
expect(new RegExp("^" + U.cookie + "=mi-c-m;.*domain=" + rules.cookie_domain.replace(".", "\.")).test(units.document.cookie),
  "units cookie is not written as " + U.cookie + " on " + rules.cookie_domain);

// Names that no dictionary may translate.
const PREFIX = "window.EUC_I18N_DICT = ";
// Polish declines the name (w Dropboksie), and so does the app's own label
// that the upload hint quotes, so there the stem counts.
const DECLINED = { pl: { Dropbox: /Dropbo(?:x|ks)/g } };
const count = (s, name, code) => {
  const re = code && DECLINED[code] && DECLINED[code][name];
  return re ? (s.match(re) || []).length : s.split(name).length - 1;
};
Object.keys(rules.languages).filter((c) => c !== "en").forEach((code) => {
  const file = path.join(ROOT, "static", "i18n", code + ".js");
  if (!fs.existsSync(file)) return;
  const table = JSON.parse(read("static/i18n/" + code + ".js").trim().slice(PREFIX.length, -1));
  Object.keys(table).forEach((key) => {
    rules.names_kept_in_english.forEach((name) => {
      if (count(key, name) > count(table[key], name, code)) problems.push(code + ": " + name + " was translated in " + JSON.stringify(key.slice(0, 60)));
    });
  });
});

console.log(problems.length ? problems.length + " parity problems" : "parity OK");
problems.forEach((p) => console.log("  " + p));
process.exit(problems.length ? 1 : 0);
