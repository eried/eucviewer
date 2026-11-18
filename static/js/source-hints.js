// "How to export from X" modal shown on the upload screen for euc.world and
// DarknessBot. Dropbox is handled by the single Sync dialog that lives in
// app.js (window.eucViewerOpenDropbox), so the whole app, upload screen and
// viewer alike, shares one Dropbox UI instead of two parallel dialogs.
(function () {
  "use strict";
  const i18n = window.EucI18n.t;

  function init() {
    const links = document.querySelectorAll(".hint-source");
    const root = document.getElementById("source-instructions");
    if (!links.length || !root) return;

    links.forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        const source = el.dataset.source;
        if (source === "dropbox") {
          // Hand off to the shared Sync-with-Dropbox dialog. The main button
          // loads everything straight away; the segmented caret (data-dropbox-
          // modal) opens the dialog to pick. OAuth is resumed by app.js.
          if (typeof window.eucViewerOpenDropbox === "function") {
            window.eucViewerOpenDropbox({ autoLoadAll: !el.dataset.dropboxModal });
          }
          return;
        }
        openModal(root, source);
      });
    });

    root.addEventListener("click", (ev) => {
      if (ev.target === root) closeModal(root);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !root.classList.contains("hidden")) closeModal(root);
    });
  }

  function openModal(root, source) {
    root.dataset.source = source;
    root.classList.remove("hidden");
    document.body.classList.add("src-modal-open");
    if (source === "eucworld") root.innerHTML = wrap(eucWorldBody());
    else if (source === "darknessbot") root.innerHTML = wrap(darknessBotBody());
    else { closeModal(root); return; }
    const close = root.querySelector(".src-close");
    if (close) close.addEventListener("click", () => closeModal(root));
  }

  function closeModal(root) {
    root.classList.add("hidden");
    root.dataset.source = "";
    document.body.classList.remove("src-modal-open");
  }

  function wrap(bodyHtml, extraClass) {
    const cls = "src-card" + (extraClass ? " " + extraClass : "");
    return `<div class="${cls}" role="dialog" aria-modal="true">${bodyHtml}</div>`;
  }

  // Bookmarklet source, kept short. The real exporter is fetched at runtime
  // so iterating on the script doesn't force users to re-create their bookmark.
  function buildBookmarkletHref(scriptUrl) {
    const code = `(function(){var s=document.createElement('script');s.src=${JSON.stringify(scriptUrl)}+'?t='+Date.now();s.onerror=function(){alert('Could not load the exporter. Your browser may be blocking it.');};document.body.appendChild(s);})();`;
    return "javascript:" + encodeURIComponent(code);
  }

  function detectBrowser() {
    const ua = navigator.userAgent;
    const isMobile =
      /Android|iPhone|iPad|iPod|Opera Mini/i.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (isMobile) {
      return { name: i18n("Mobile"), howTo: i18n("use a desktop browser for batch export all the trips.") };
    }
    const mac = /Mac/.test(navigator.platform || ua);
    const mod = mac ? "⌘⇧B" : "Ctrl+Shift+B";
    if (/OPR\//.test(ua) || /Opera/.test(ua)) {
      return { name: "Opera", howTo: i18n("View menu → Show bookmarks bar (or {mod}).", { mod: mod }) };
    }
    if (/Edg\//.test(ua)) {
      return { name: "Edge", howTo: i18n("{mod} toggles the favorites bar.", { mod: mod }) };
    }
    if (/Firefox\//.test(ua)) {
      return { name: "Firefox", howTo: i18n("Right-click an empty toolbar area → Bookmarks Toolbar → Always Show. Or {mod}.", { mod: mod }) };
    }
    if (/Safari\//.test(ua) && !/Chrome/.test(ua)) {
      return { name: "Safari", howTo: i18n("View menu → Show Favorites Bar ({mod}).", { mod: mod }) };
    }
    return { name: "Chrome", howTo: i18n("{mod} toggles the bookmarks bar.", { mod: mod }) };
  }

  function eucWorldBody() {
    const scriptUrl = new URL("static/js/euc-world-export.js", location.href).href;
    const href = buildBookmarkletHref(scriptUrl);
    const fav = new URL("static/favicon.svg", location.href).href;
    const browser = detectBrowser();
    return `
      <header class="src-head">
        <h3>${i18n("Export your trips from euc.world")}</h3>
        <button type="button" class="src-close" aria-label="${i18n("Close")}">&times;</button>
      </header>
      <p class="src-sub">${i18n("All trips at once")} <span class="src-sub-tag">${i18n("recommended")}</span></p>
      <ol class="src-steps">
        <li>${i18n("Make sure the bookmarks bar is visible.")}
          <div class="src-hint">${browser.name}: ${browser.howTo}</div></li>
        <li>${i18n("Drag this to your bookmarks bar:")}
          <div class="src-bookmarklet-wrap">
            <a class="src-bookmarklet" href="${href}" onclick="return false;" draggable="true">
              <img src="${fav}" alt="" class="src-bm-icon" />
              <span>${i18n("Takeout my trips")}</span>
            </a>
          </div></li>
        <li>${i18n("Open <a {attrs}>euc.world</a>, sign in.", { attrs: 'href="https://euc.world/account/tours" target="_blank" rel="noopener"' })}</li>
        <li>${i18n("Click the <strong>Takeout my trips</strong> toolbar button.")}</li>
        <li>${i18n("Drop the downloaded <code>.zip</code> here.")}</li>
      </ol>
      <p class="src-sub">${i18n("A single ride")}</p>
      <ol class="src-steps">
        <li>${i18n("Open <a {attrs}>euc.world</a>, sign in.", { attrs: 'href="https://euc.world/account/tours" target="_blank" rel="noopener"' })}</li>
        <li>${i18n("Open a tour from the list.")}</li>
        <li>${i18n("Use the tour's <strong>Menu</strong> &rarr; <strong>Export to XLSX</strong> or <strong>GPX</strong>.")}
          <div class="src-hint">${i18n("XLSX has full telemetry. GPX is GPS only.")}</div></li>
        <li>${i18n("Drop the file here.")}</li>
      </ol>
    `;
  }

  function darknessBotBody() {
    return `
      <header class="src-head">
        <h3>${i18n("From DarknessBot")}</h3>
        <button type="button" class="src-close" aria-label="${i18n("Close")}">&times;</button>
      </header>
      <p class="src-sub">${i18n("All trips at once")} <span class="src-sub-tag">${i18n("recommended")}</span></p>
      <ol class="src-steps">
        <li>${i18n("Open <strong>Settings</strong> &rarr; <strong>Application</strong> &rarr; <strong>App data</strong>.")}</li>
        <li>${i18n("Tap <strong>Export trips</strong> and save the exported file.")}</li>
        <li>${i18n("Drop it here.")}</li>
      </ol>
      <p class="src-sub">${i18n("A single ride")}</p>
      <ol class="src-steps">
        <li>${i18n("Open <strong>Trips</strong> and select a ride from the list.")}</li>
        <li>${i18n("Tap <strong>Share</strong>, pick <strong>CSV</strong>. Send it to Files or email.")}</li>
        <li>${i18n("Drop the <code>.csv</code> here.")}</li>
      </ol>
    `;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
