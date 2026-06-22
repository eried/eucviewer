// Source-specific "how to export from X" modal shown on the upload screen.
// Knows DarknessBot (info-only), euc.world (bookmarklet export), and
// Dropbox (PKCE OAuth + bulk load from the app folder).
(function () {
  "use strict";

  function init() {
    const links = document.querySelectorAll(".hint-source");
    const root = document.getElementById("source-instructions");
    if (!links.length || !root) return;

    links.forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        const source = el.dataset.source;
        // Big "Dropbox" button: when already linked, skip the modal and
        // start the trip download right away. The hint-aside link still
        // has data-dropbox-modal so the user can reach Sign out.
        if (source === "dropbox"
            && !el.dataset.dropboxModal
            && window.DropboxSource
            && DropboxSource.isAuthenticated()) {
          runDropboxDirectLoad();
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

    // If we just came back from a Dropbox OAuth round-trip, pop the modal
    // open in its connected state once the token exchange resolves.
    if (window.DropboxSource && DropboxSource.maybeHandleCallback) {
      DropboxSource.maybeHandleCallback().then((ok) => {
        if (ok || DropboxSource.consumeJustConnected()) {
          openModal(root, "dropbox");
        }
      });
    }
  }

  function openModal(root, source) {
    root.dataset.source = source;
    root.classList.remove("hidden");
    document.body.classList.add("src-modal-open");
    if (source === "eucworld") root.innerHTML = wrap(eucWorldBody());
    else if (source === "darknessbot") root.innerHTML = wrap(darknessBotBody());
    else if (source === "dropbox") { renderDropbox(root); return; }
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
      <p class="src-sub">All trips at once <span class="src-sub-tag">recommended</span></p>
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
        <li>Drop the downloaded <code>.dbb</code> here.</li>
      </ol>
      <p class="src-sub">A single ride</p>
      <ol class="src-steps">
        <li>Open <a href="https://euc.world/account/tours" target="_blank" rel="noopener">euc.world</a>, sign in.</li>
        <li>Open a tour from the list.</li>
        <li>Use the tour's <strong>Menu</strong> &rarr; <strong>Export to XLSX</strong> or <strong>Export to GPX</strong>.
          <div class="src-hint">XLSX is richer: speed, voltage, temperature, battery and more. GPX is the GPS track only.</div></li>
        <li>Drop the file here.</li>
      </ol>
    `;
  }

  function darknessBotBody() {
    return `
      <header class="src-head">
        <h3>From DarknessBot</h3>
        <button type="button" class="src-close" aria-label="Close">&times;</button>
      </header>
      <p class="src-sub">All trips at once <span class="src-sub-tag">recommended</span></p>
      <ol class="src-steps">
        <li>Open <strong>Settings</strong> &rarr; <strong>Application</strong> &rarr; <strong>App data</strong>.</li>
        <li>Tap <strong>Export trips</strong> and save the <code>.dbb</code> file.</li>
        <li>Drop the <code>.dbb</code> here.</li>
      </ol>
      <p class="src-sub">A single ride</p>
      <ol class="src-steps">
        <li>Open <strong>Trips</strong> and select a ride from the list.</li>
        <li>Tap <strong>Share</strong>, pick <strong>CSV</strong>. Send it to Files or email.</li>
        <li>Drop the <code>.csv</code> here.</li>
      </ol>
    `;
  }

  // --- Dropbox source ---------------------------------------------------

  function renderDropbox(root) {
    const dbx = window.DropboxSource;
    if (!dbx) {
      root.innerHTML = wrap(`
        <header class="src-head">
          <h3>From Dropbox</h3>
          <button type="button" class="src-close" aria-label="Close">&times;</button>
        </header>
        <p class="src-note">Dropbox helper script failed to load. Refresh and try again.</p>
      `);
      const c = root.querySelector(".src-close");
      if (c) c.addEventListener("click", () => closeModal(root));
      return;
    }

    if (dbx.isAuthenticated()) {
      renderDropboxConnected(root, dbx);
    } else {
      renderDropboxIntro(root, dbx);
    }
  }

  function renderDropboxIntro(root, dbx) {
    root.innerHTML = wrap(`
      <header class="src-head">
        <h3>Dropbox</h3>
        <button type="button" class="src-close" aria-label="Close">&times;</button>
      </header>
      <p class="src-body">Loads every CSV in <code>Apps/EUC Planet/trips/</code>. Read-only.</p>
      <div class="src-action">
        <button type="button" id="dbx-connect" class="src-primary-btn">
          <span>Connect Dropbox</span>
        </button>
      </div>
    `);
    root.querySelector(".src-close").addEventListener("click", () => closeModal(root));
    root.querySelector("#dbx-connect").addEventListener("click", () => {
      dbx.startOAuth().catch((e) => alert("Could not start sign-in: " + e.message));
    });
  }

  function renderDropboxConnected(root, dbx) {
    const acc = dbx.accountName();
    root.innerHTML = wrap(`
      <header class="src-head">
        <h3>Dropbox connected</h3>
        <button type="button" class="src-close" aria-label="Close">&times;</button>
      </header>
      <p class="src-sub">${acc ? escapeHtml(acc) : "Signed in"} &middot; Apps/EUC Planet/trips/</p>
      <div id="dbx-listing" class="dbx-listing">
        <div class="dbx-loading">Listing trips…</div>
      </div>
      <div class="src-action src-action-row">
        <button type="button" id="dbx-signout" class="src-secondary-btn">Sign out</button>
        <button type="button" id="dbx-load" class="src-primary-btn" disabled>
          <span id="dbx-load-label">Load trips</span>
        </button>
      </div>
      <div id="dbx-status" class="src-hint dbx-status"></div>
    `);

    const closeBtn = root.querySelector(".src-close");
    const loadBtn = root.querySelector("#dbx-load");
    const loadLabel = root.querySelector("#dbx-load-label");
    const signoutBtn = root.querySelector("#dbx-signout");
    const status = root.querySelector("#dbx-status");
    const listing = root.querySelector("#dbx-listing");

    closeBtn.addEventListener("click", () => closeModal(root));
    signoutBtn.addEventListener("click", () => {
      dbx.signOut();
      renderDropbox(root);
    });

    let files = [];
    let cachedSet = new Set();

    async function refreshCachedSet() {
      cachedSet = new Set();
      if (!dbx.cache) return;
      for (const f of files) {
        if (!f.contentHash) continue;
        const entry = await dbx.cache.get(f.path);
        if (entry && entry.contentHash === f.contentHash) cachedSet.add(f.path);
      }
    }

    function renderList() {
      if (!files.length) {
        listing.innerHTML = `<div class="dbx-empty">No trips found yet.</div>`;
        loadLabel.textContent = "Load trips";
        loadBtn.disabled = true;
        return;
      }
      const totalBytes = files.reduce((s, e) => s + (e.size || 0), 0);
      const cachedCount = cachedSet.size;
      const iconCached = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8.5l4 4 8-9"/></svg>`;
      const iconRemote = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 11.5h6a3 3 0 0 0 .3-5.97A4.5 4.5 0 0 0 2.5 7.7a2.7 2.7 0 0 0 2 3.8z"/><path d="M8 8v4"/><path d="M6 10l2 2 2-2"/></svg>`;
      const rows = files.map((f) => {
        const cached = cachedSet.has(f.path);
        const date = f.modified ? f.modified.slice(0, 10) : "";
        return `
          <li class="dbx-row${cached ? " is-cached" : ""}" data-path="${escapeHtml(f.path)}">
            <span class="dbx-row-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <span class="dbx-row-meta">${escapeHtml(date)} &middot; ${formatBytes(f.size || 0)}</span>
            <span class="dbx-row-tag" title="${cached ? "Already cached locally" : "Will be fetched from Dropbox"}">${cached ? iconCached : iconRemote}</span>
            <button type="button" class="dbx-row-open" data-path="${escapeHtml(f.path)}" title="Load just this trip">Open</button>
          </li>
        `;
      }).join("");
      listing.innerHTML = `
        <div class="dbx-summary">
          <strong>${files.length}</strong> ${files.length === 1 ? "trip" : "trips"}
          <span class="dbx-summary-sep">&middot;</span>
          ${formatBytes(totalBytes)}
          ${dbx.cache ? `
            <span class="dbx-summary-sep">&middot;</span>
            <span class="dbx-cached-count">${cachedCount} cached</span>
            ${cachedCount ? `<button type="button" id="dbx-clear-cache" class="src-link-btn dbx-clear">Clear cache</button>` : ""}
          ` : ""}
        </div>
        <ul class="dbx-rows">${rows}</ul>
      `;
      // Latest is first (list is sorted desc by modified), make sure the
      // top is visible after re-render.
      listing.scrollTop = 0;

      // Wire row Open buttons to load that single trip.
      listing.querySelectorAll(".dbx-row-open").forEach((btn) => {
        btn.addEventListener("click", () => loadOne(btn.dataset.path));
      });
      const clearBtn = listing.querySelector("#dbx-clear-cache");
      if (clearBtn) clearBtn.addEventListener("click", clearCache);

      loadLabel.textContent = `Load ${files.length} ${files.length === 1 ? "trip" : "trips"}`;
      loadBtn.disabled = false;
    }

    async function clearCache() {
      if (!dbx.cache) return;
      status.textContent = "Clearing cache…";
      await dbx.cache.clear();
      await refreshCachedSet();
      status.textContent = "";
      renderList();
    }

    async function loadOne(path) {
      const f = files.find((x) => x.path === path);
      if (!f) return;
      loadBtn.disabled = true;
      signoutBtn.disabled = true;
      status.textContent = `Fetching ${f.name}…`;
      try {
        const blob = await downloadAndBundle([f], () => {});
        const file = new File([blob], `dropbox_${f.name.replace(/\.[^.]+$/, "")}.dbb`, { type: "application/zip" });
        closeModal(root);
        if (typeof window.eucViewerLoadFile === "function") {
          window.eucViewerLoadFile(file, { dropboxMap: blob.__dropboxMap });
        }
      } catch (e) {
        status.textContent = "Failed: " + (e.message || e);
        loadBtn.disabled = false;
        signoutBtn.disabled = false;
      }
    }

    dbx.listTripFiles().then(async (entries) => {
      files = entries;
      await refreshCachedSet();
      renderList();
    }).catch((e) => {
      listing.innerHTML = `<div class="dbx-error">Couldn't list folder: ${escapeHtml(e.message || String(e))}</div>`;
      loadLabel.textContent = "Retry";
      loadBtn.disabled = false;
      loadBtn.dataset.mode = "retry";
    });

    loadBtn.addEventListener("click", async () => {
      if (loadBtn.dataset.mode === "retry") {
        renderDropbox(root);
        return;
      }
      if (!files.length) return;
      loadBtn.disabled = true;
      signoutBtn.disabled = true;
      try {
        const blob = await downloadAndBundle(files, (i, total, name, hit) => {
          status.textContent = `${hit ? "From cache" : "Fetching"} ${i} of ${total}: ${name}`;
        });
        const fromCache = blob.__fromCache || 0;
        status.textContent = fromCache
          ? `Handing off to the parser (${fromCache} of ${files.length} from cache)…`
          : "Handing off to the parser…";
        const stamp = new Date().toISOString().slice(0, 10);
        const file = new File([blob], `dropbox_${stamp}.dbb`, { type: "application/zip" });
        closeModal(root);
        if (typeof window.eucViewerLoadFile === "function") {
          window.eucViewerLoadFile(file, { dropboxMap: blob.__dropboxMap });
        } else {
          alert("Viewer not ready — try refreshing the page.");
        }
      } catch (e) {
        status.textContent = "Failed: " + (e.message || e);
        loadBtn.disabled = false;
        signoutBtn.disabled = false;
      }
    });
  }

  function showInlineStatus(msg, isError) {
    let el = document.getElementById("dropbox-inline-status");
    if (!el) {
      el = document.createElement("div");
      el.id = "dropbox-inline-status";
      const actions = document.getElementById("upload-actions");
      if (actions && actions.parentNode) actions.parentNode.insertBefore(el, actions.nextSibling);
      else document.body.appendChild(el);
    }
    el.className = "dropbox-inline-status" + (isError ? " is-error" : "");
    el.textContent = msg;
  }
  function clearInlineStatus() {
    const el = document.getElementById("dropbox-inline-status");
    if (el) el.remove();
  }

  async function runDropboxDirectLoad() {
    const dbx = window.DropboxSource;
    const progressArea = document.getElementById("progress-area");
    const progressText = document.getElementById("progress-text");
    const progressFill = document.getElementById("progress-fill");
    const uploadActions = document.getElementById("upload-actions");

    clearInlineStatus();
    if (uploadActions) uploadActions.classList.add("hidden");
    if (progressArea) progressArea.classList.remove("hidden");
    if (progressText) {
      progressText.textContent = "Listing Dropbox trips…";
      progressText.classList.remove("error");
    }
    if (progressFill) progressFill.style.width = "10%";

    const bail = (msg) => {
      if (progressArea) progressArea.classList.add("hidden");
      if (progressFill) progressFill.style.width = "0%";
      if (progressText) progressText.textContent = "";
      if (uploadActions) uploadActions.classList.remove("hidden");
      showInlineStatus(msg, true);
    };

    try {
      const files = await dbx.listTripFiles();
      if (!files.length) {
        bail("No trips found in your Dropbox.");
        return;
      }
      const blob = await downloadAndBundle(files, (i, total) => {
        if (progressText) progressText.textContent = `Fetching ${i} of ${total}`;
        if (progressFill) progressFill.style.width = Math.round((i / total) * 90) + "%";
      });
      if (progressFill) progressFill.style.width = "100%";
      const stamp = new Date().toISOString().slice(0, 10);
      const file = new File([blob], `dropbox_${stamp}.dbb`, { type: "application/zip" });
      if (typeof window.eucViewerLoadFile === "function") {
        window.eucViewerLoadFile(file, { dropboxMap: blob.__dropboxMap });
      } else {
        throw new Error("Viewer not ready");
      }
    } catch (e) {
      bail("Dropbox load failed: " + (e.message || e));
    }
  }

  async function downloadAndBundle(files, onProgress) {
    if (typeof window.JSZip === "undefined") throw new Error("ZIP library not loaded");
    const zip = new window.JSZip();
    const used = new Set();
    const cache = window.DropboxSource && window.DropboxSource.cache;
    const dropboxMap = {};
    let fromCache = 0;
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      let blob = null;
      let hit = false;
      if (cache) {
        const cached = await cache.get(f.path);
        if (cached && cached.blob && cached.contentHash && cached.contentHash === f.contentHash) {
          blob = cached.blob;
          hit = true;
          fromCache += 1;
        }
      }
      if (onProgress) onProgress(i + 1, files.length, f.name, hit);
      if (!blob) {
        blob = await window.DropboxSource.downloadBlob(f.path);
        if (cache && f.contentHash) {
          await cache.put(f.path, {
            blob,
            contentHash: f.contentHash,
            size: f.size,
            name: f.name,
            modified: f.modified,
            cachedAt: Date.now(),
          });
        }
      }
      const name = uniqueName(f.name, used);
      zip.file(name, blob);
      dropboxMap[name] = f.path;
    }
    const out = await zip.generateAsync({ type: "blob", compression: "STORE" });
    out.__fromCache = fromCache;
    out.__dropboxMap = dropboxMap;
    return out;
  }

  function uniqueName(base, used) {
    if (!used.has(base)) { used.add(base); return base; }
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let n = 2; n < 1000; n += 1) {
      const c = stem + "_" + n + ext;
      if (!used.has(c)) { used.add(c); return c; }
    }
    return base;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function formatBytes(n) {
    if (!n) return "0 KB";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + " " + u[i];
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
