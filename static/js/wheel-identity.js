// How a wheel is named, keyed and folded, in one place.
//
// The viewer and Forensics both group trips by wheel, and the viewer hands a
// chosen wheel to Forensics through ?wheel=<key>, so the two pages have to
// spell the key the same way for ever. They used to carry their own copies of
// this, which had already drifted at the edges: the same wheel with no model
// came out as "Wheel" on one page and null on the other.
(function (global) {
  "use strict";

  // Some wheels report the brand inside the model ("InMotion P6"); don't
  // double it up in the label. A wheel that reported nothing but a MAC is
  // named after it, because "Wheel" on its own tells you nothing.
  function labelOfWheel(w) {
    if (!w) return null;
    const modelHasMake = w.make && w.model &&
      w.model.toLowerCase().startsWith(w.make.toLowerCase());
    const label = modelHasMake ? w.model : [w.make, w.model].filter(Boolean).join(" ");
    return label || w.name || (w.mac ? "Wheel " + w.mac : null);
  }

  // What the viewer puts in ?wheel= and what Forensics matches against.
  // Changing it breaks that handoff, so change it in both or in neither.
  function groupKey(label, w) {
    return label + "|" + ((w && (w.serial || w.mac)) || "");
  }

  // Trips are bucketed on the whole identity rather than the label, because
  // telling the partial identities apart is what lets foldWheelIdentities put
  // them back together.
  function bucketKey(w) {
    return [labelOfWheel(w), (w && w.serial) || "", (w && w.mac) || "", (w && w.name) || ""]
      .join("\u0000");
  }

  // One wheel can be written down in more detail on one trip than on another:
  // EUC Planet names the full identity when it knows it and falls back to the
  // bare BLE name ("Adventure-E0000298") when it does not, so the same wheel
  // arrived as two, listed side by side under the same name. Identities that
  // share a serial or a MAC are the same wheel. One carrying neither joins the
  // wheel of that name when only one wheel answers to it; when several do,
  // there is nothing to tell them apart with, so it stays on its own.
  // Buckets are { w, items }; the fullest identity wins the merged bucket.
  function foldWheelIdentities(buckets) {
    const idOf = (w) => String((w && (w.serial || w.mac)) || "").trim().toLowerCase();
    const nameOf = (w) => String((w && w.name) || "").trim().toLowerCase();
    const score = (w) => (w.model ? 4 : 0) + (w.make ? 2 : 0) + (w.name ? 1 : 0) + (idOf(w) ? 1 : 0);
    const byId = new Map();
    const out = [];
    const idless = [];
    const join = (into, b) => {
      into.items = into.items.concat(b.items);
      if (score(b.w) > score(into.w)) into.w = b.w;
    };
    for (const b of buckets) {
      const id = idOf(b.w);
      if (!id) { idless.push(b); continue; }
      const hit = byId.get(id);
      if (hit) { join(hit, b); continue; }
      const nb = { w: b.w, items: b.items.slice() };
      byId.set(id, nb);
      out.push(nb);
    }
    for (const b of idless) {
      const nm = nameOf(b.w);
      const hits = nm ? out.filter((o) => nameOf(o.w) === nm) : [];
      if (hits.length === 1) join(hits[0], b);
      else out.push({ w: b.w, items: b.items.slice() });
    }
    return out;
  }

  global.WheelIdentity = { labelOfWheel, groupKey, bucketKey, foldWheelIdentities };
})(window);
