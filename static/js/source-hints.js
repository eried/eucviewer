// Source-specific "how to export from X" modal shown on the upload screen.
// Currently knows DarknessBot (info-only) and euc.world (bookmarklet export).
(function () {
  "use strict";

  function init() {
    const links = document.querySelectorAll("#upload-hint a.hint-source");
    const root = document.getElementById("source-instructions");
    if (!links.length || !root) return;

    links.forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        openModal(root, a.dataset.source);
      });
    });

    // Close on backdrop click / Escape.
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

  function wrap(bodyHtml) {
    return `<div class="src-card" role="dialog" aria-modal="true">${bodyHtml}</div>`;
  }

  // Bookmarklet source — kept short. The real exporter is fetched at runtime
  // so iterating on the script doesn't force users to re-create their bookmark.
  function buildBookmarkletHref(scriptUrl) {
    const code = `(function(){var s=document.createElement('script');s.src=${JSON.stringify(scriptUrl)}+'?t='+Date.now();s.onerror=function(){alert('Could not load the exporter. Your browser may be blocking it.');};document.body.appendChild(s);})();`;
    return "javascript:" + encodeURIComponent(code);
  }

  function detectBrowser() {
    const ua = navigator.userAgent;
    // Mobile check first — bookmarklets don't drag-and-drop on phones.
    // iPad in Safari Desktop mode reports as Macintosh but has touch points.
    const isMobile =
      /Android|iPhone|iPad|iPod|Opera Mini/i.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (isMobile) {
      return { name: "Mobile", howTo: "use a desktop browser for batch export all the trips." };
    }
    const mac = /Mac/.test(navigator.platform || ua);
    const mod = mac ? "⌘⇧B" : "Ctrl+Shift+B";
    if (/OPR\//.test(ua) || /Opera/.test(ua)) {
      return { name: "Opera", howTo: "View menu → Show bookmarks bar (or " + mod + ")." };
    }
    if (/Edg\//.test(ua)) {
      return { name: "Edge", howTo: mod + " toggles the favorites bar." };
    }
    if (/Firefox\//.test(ua)) {
      return { name: "Firefox", howTo: "Right-click an empty toolbar area → Bookmarks Toolbar → Always Show. Or " + mod + "." };
    }
    if (/Safari\//.test(ua) && !/Chrome/.test(ua)) {
      return { name: "Safari", howTo: "View menu → Show Favorites Bar (" + mod + ")." };
    }
    return { name: "Chrome", howTo: mod + " toggles the bookmarks bar." };
  }

  function eucWorldBody() {
    const scriptUrl = new URL("static/js/euc-world-export.js", location.href).href;
    const href = buildBookmarkletHref(scriptUrl);
    const fav = new URL("static/favicon.svg", location.href).href;
    const browser = detectBrowser();
    return `
      <header class="src-head">
        <h3>Export your trips from euc.world</h3>
        <button type="button" class="src-close" aria-label="Close">&times;</button>
      </header>
      <ol class="src-steps">
        <li>Make sure the bookmarks bar is visible.
          <div class="src-hint">${browser.name}: ${browser.howTo}</div></li>
        <li>Drag this to your bookmarks bar:
          <div class="src-bookmarklet-wrap">
            <a class="src-bookmarklet" href="${href}" onclick="return false;" draggable="true">
              <img src="${fav}" alt="" class="src-bm-icon" />
              <span>Takeout my trips</span>
            </a>
          </div></li>
        <li>Open <a href="https://euc.world/account/tours" target="_blank" rel="noopener">euc.world</a>, sign in.</li>
        <li>Click the <strong>Takeout my trips</strong> toolbar button.</li>
        <li>Now you own all your trips, enjoy!
          <div class="src-hint">You can import the file into the EUC Planet app, or open it at <a href="https://eucviewer.ried.no/" target="_blank" rel="noopener">eucviewer.ried.no</a>.</div></li>
      </ol>
    `;
  }

  function darknessBotBody() {
    return `
      <header class="src-head">
        <h3>From DarknessBot</h3>
        <button type="button" class="src-close" aria-label="Close">&times;</button>
      </header>
      <ol class="src-steps">
        <li>Open a ride, tap <strong>Share</strong>.</li>
        <li>Pick CSV. Send it to Files or email.</li>
        <li>Drop it here.</li>
      </ol>
      <div class="src-note">One ride at a time. No bulk export.</div>
    `;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
