#!/usr/bin/env python3
"""Collect every translatable string and check the dictionaries against them.

    python tools/i18n_extract.py           write static/i18n/keys.json, then check
    python tools/i18n_extract.py --check   check only, exit 1 on any problem

The English text is the key (see static/js/i18n.js). Keys come from two places:
i18n("...") calls in static/js/*.js, and markup carrying data-i18n,
data-i18n-html or data-i18n-attrs in the *.html pages.

A dictionary (static/i18n/<code>.js) is one line of wrapper around a JSON
object. It passes when it has every key and nothing else, keeps each key's
{placeholders}, keeps its HTML tags, and keeps unit symbols as written.
"""
import glob
import html
import io
import json
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "static", "i18n")
PREFIX = "window.EUC_I18N_DICT = "

CALL = re.compile(r'(?<![\w.$])i18n\(\s*("(?:[^"\\\n]|\\.)*")')
ANY_CALL = re.compile(r'(?<![\w.$])i18n\(\s*(.)')


def squash(s):
    return re.sub(r"\s+", " ", s).strip()


def js_keys(path, problems):
    src = io.open(path, encoding="utf-8").read()
    keys = []
    for m in CALL.finditer(src):
        lit = m.group(1).replace("\\'", "'")
        try:
            keys.append(json.loads(lit))
        except ValueError:
            problems.append("%s: cannot read literal %s" % (os.path.relpath(path, ROOT), lit[:60]))
    for m in ANY_CALL.finditer(src):
        if m.group(1) != '"':
            line = src.count("\n", 0, m.start()) + 1
            problems.append("%s:%d: i18n() needs a plain double-quoted literal first"
                            % (os.path.relpath(path, ROOT), line))
    return keys


class Markup(HTMLParser):
    """Text of data-i18n elements and the listed attributes."""

    def __init__(self, path, problems):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.path, self.problems = path, problems
        self.keys = []
        self.open = None  # [tag, depth, text] while inside a data-i18n element

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.open:
            self.problems.append("%s: <%s> inside a data-i18n element; use data-i18n-html"
                                 % (self.path, tag))
        for name in (a.get("data-i18n-attrs") or "").split():
            if a.get(name):
                self.keys.append(a[name])
            else:
                self.problems.append("%s: data-i18n-attrs names %s but <%s> has none"
                                     % (self.path, name, tag))
        if "data-i18n" in a:
            if a["data-i18n"]:
                self.keys.append(a["data-i18n"])
            else:
                self.open = [tag, ""]

    def handle_data(self, data):
        if self.open:
            self.open[1] += data

    def handle_endtag(self, tag):
        if self.open and tag == self.open[0]:
            self.keys.append(squash(self.open[1]))
            self.open = None


ENTITY = re.compile(r"&(#\d+|#x[0-9a-fA-F]+|\w+);")
KEPT = {"amp", "lt", "gt", "nbsp"}


def as_inner_html(src):
    """Source markup as the browser hands it back from innerHTML: every
    entity but the four it must keep becomes the character itself."""
    return ENTITY.sub(lambda m: m.group(0) if m.group(1) in KEPT else html.unescape(m.group(0)), src)


HTML_BLOCK = re.compile(r"<(\w+)\b[^>]*\bdata-i18n-html(?:=\"\")?[^>]*>(.*?)</\1>", re.S)


def html_keys(path, problems):
    src = io.open(path, encoding="utf-8").read()
    rel = os.path.relpath(path, ROOT)
    p = Markup(rel, problems)
    p.feed(src)
    keys = p.keys
    # The markup key is the browser's innerHTML, which for the plain,
    # double-quoted, lower-case markup these pages use is the source itself.
    keys += [squash(as_inner_html(m.group(2))) for m in HTML_BLOCK.finditer(src)]
    return keys


def collect():
    problems, keys = [], []
    for path in sorted(glob.glob(os.path.join(ROOT, "static", "js", "*.js"))):
        if os.path.basename(path) == "i18n.js":
            continue
        keys += js_keys(path, problems)
    for path in sorted(glob.glob(os.path.join(ROOT, "*.html"))):
        keys += html_keys(path, problems)
    return sorted(set(k for k in keys if k)), problems


# Forensics converts units inside its static copy by finding these symbols,
# after translation. A localised unit would be left in metric.
UNITS = ["km/h", "mph", "Wh/km", "Wh/mi", "°C", "°F", "km/%", "%/h"]
PLACEHOLDER = re.compile(r"\{(\w+)\}")
TAG = re.compile(r"</?\s*(\w+)")


PLURAL_LANGS = ("ru", "uk", "pl", "cs", "sk", "ro")


def check(keys):
    problems = []
    want = set(keys)
    for path in sorted(glob.glob(os.path.join(OUT, "*.js"))):
        name = os.path.basename(path)
        src = io.open(path, encoding="utf-8").read().strip()
        if not src.startswith(PREFIX) or not src.endswith(";"):
            problems.append("%s: not '%s{...};'" % (name, PREFIX))
            continue
        try:
            table = json.loads(src[len(PREFIX):-1])
        except ValueError as e:
            problems.append("%s: not JSON inside the wrapper (%s)" % (name, e))
            continue
        # Count forms ride along as "<key>|one|few|many" in the languages
        # i18n.js pluralForm() knows; each is checked against its key.
        code = name[:-3]
        forms = {}
        for k in list(table):
            base, bar, form = k.rpartition("|")
            if bar and form in ("one", "few", "many") and base in want:
                if code not in PLURAL_LANGS:
                    problems.append("%s: count form %r in a language without them" % (name, k[:50]))
                elif "{n}" not in base:
                    problems.append("%s: count form for a key without {n}: %r" % (name, k[:50]))
                forms[k] = base
        missing = sorted(want - set(table))
        extra = sorted(set(table) - want - set(forms))
        if missing:
            problems.append("%s: %d missing, e.g. %r" % (name, len(missing), missing[:3]))
        if extra:
            problems.append("%s: %d not in use, e.g. %r" % (name, len(extra), extra[:3]))
        for k, v in table.items():
            k = forms.get(k, k)
            if k not in want:
                continue
            if not isinstance(v, str) or not v.strip():
                problems.append("%s: empty translation for %r" % (name, k[:50]))
                continue
            if sorted(PLACEHOLDER.findall(k)) != sorted(PLACEHOLDER.findall(v)):
                problems.append("%s: placeholders differ for %r" % (name, k[:50]))
            if sorted(t.lower() for t in TAG.findall(k)) != sorted(t.lower() for t in TAG.findall(v)):
                problems.append("%s: tags differ for %r" % (name, k[:50]))
            for unit in UNITS:
                if k.count(unit) != v.count(unit):
                    problems.append("%s: unit %s changed in %r" % (name, unit, k[:50]))
                    break
    return problems


def main():
    keys, problems = collect()
    if "--check" not in sys.argv:
        os.makedirs(OUT, exist_ok=True)
        with io.open(os.path.join(OUT, "keys.json"), "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(keys, ensure_ascii=False, indent=0) + "\n")
    problems += check(keys)
    print("%d keys" % len(keys))
    for p in problems:
        print("  " + p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
