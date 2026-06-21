// Dropbox source — PKCE OAuth + listing CSV trips from the app folder.
// Static-site safe: no client secret embedded. The Dropbox app must be a
// "Scoped App (App Folder)" with redirect URIs that include this page.
(function () {
  "use strict";

  const APP_KEY = "5auhxf7gswy7j54";
  const TRIPS_PATH = "/trips";
  const ALLOWED_EXT = /\.(csv|gpx|xlsx|dbb)$/i;

  const STORE = {
    ACCESS: "dbx_access_token",
    REFRESH: "dbx_refresh_token",
    EXPIRES: "dbx_expires_at",
    VERIFIER: "dbx_pkce_verifier",
    ACCOUNT: "dbx_account",
    JUST_CONNECTED: "dbx_just_connected",
  };

  function redirectUri() {
    return location.origin + location.pathname;
  }

  function b64url(buf) {
    let s = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function makePkce() {
    const arr = crypto.getRandomValues(new Uint8Array(32));
    const verifier = b64url(arr);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(hash) };
  }

  function isAuthenticated() {
    if (!localStorage.getItem(STORE.ACCESS)) return false;
    return true;
  }

  function accountName() {
    return localStorage.getItem(STORE.ACCOUNT) || "";
  }

  async function startOAuth() {
    const { verifier, challenge } = await makePkce();
    localStorage.setItem(STORE.VERIFIER, verifier);
    const params = new URLSearchParams({
      client_id: APP_KEY,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "offline",
      redirect_uri: redirectUri(),
    });
    location.assign("https://www.dropbox.com/oauth2/authorize?" + params.toString());
  }

  async function exchangeCode(code) {
    const verifier = localStorage.getItem(STORE.VERIFIER);
    if (!verifier) throw new Error("PKCE verifier missing");
    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: APP_KEY,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
    });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error("token exchange " + res.status + ": " + (await res.text()));
    const data = await res.json();
    localStorage.removeItem(STORE.VERIFIER);
    localStorage.setItem(STORE.ACCESS, data.access_token);
    if (data.refresh_token) localStorage.setItem(STORE.REFRESH, data.refresh_token);
    if (data.expires_in) {
      const exp = Date.now() + Math.max(0, (data.expires_in - 60) * 1000);
      localStorage.setItem(STORE.EXPIRES, String(exp));
    }
    try {
      const acc = await rpc("/2/users/get_current_account", null);
      const name = acc && acc.name ? (acc.name.display_name || acc.name.given_name || "") : "";
      if (name) localStorage.setItem(STORE.ACCOUNT, name);
    } catch (_e) { /* non-fatal */ }
  }

  async function refresh() {
    const rt = localStorage.getItem(STORE.REFRESH);
    if (!rt) throw new Error("no refresh token");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: APP_KEY,
    });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) signOut();
      throw new Error("refresh " + res.status + ": " + (await res.text()));
    }
    const data = await res.json();
    localStorage.setItem(STORE.ACCESS, data.access_token);
    if (data.expires_in) {
      const exp = Date.now() + Math.max(0, (data.expires_in - 60) * 1000);
      localStorage.setItem(STORE.EXPIRES, String(exp));
    }
  }

  async function ensureToken() {
    const exp = parseInt(localStorage.getItem(STORE.EXPIRES) || "0", 10);
    const tok = localStorage.getItem(STORE.ACCESS);
    if (tok && Date.now() < exp - 30000) return tok;
    if (localStorage.getItem(STORE.REFRESH)) {
      await refresh();
      return localStorage.getItem(STORE.ACCESS);
    }
    return tok;
  }

  async function rpc(endpoint, body) {
    const token = await ensureToken();
    if (!token) throw new Error("not signed in");
    const headers = { Authorization: "Bearer " + token };
    let payload;
    if (body != null) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch("https://api.dropboxapi.com" + endpoint, {
      method: "POST", headers, body: payload,
    });
    if (res.status === 401) {
      signOut();
      throw new Error("session expired, sign in again");
    }
    if (!res.ok) throw new Error(endpoint + " " + res.status + ": " + (await res.text()));
    return res.json();
  }

  async function listTripFiles() {
    const out = [];
    let cursor = null;
    try {
      while (true) {
        const data = cursor
          ? await rpc("/2/files/list_folder/continue", { cursor })
          : await rpc("/2/files/list_folder", {
              path: TRIPS_PATH, recursive: false, include_deleted: false,
            });
        for (const ent of (data.entries || [])) {
          if (ent[".tag"] === "file" && ALLOWED_EXT.test(ent.name)) {
            out.push({
              path: ent.path_lower || ent.path_display,
              name: ent.name,
              size: ent.size || 0,
              modified: ent.client_modified || ent.server_modified || "",
            });
          }
        }
        if (data.has_more) cursor = data.cursor;
        else break;
      }
    } catch (e) {
      const msg = String(e.message || e);
      // App Folder is created lazily — list_folder returns "not_found" until
      // the user's app first writes something. Treat as empty, not error.
      if (/path\/not_found/i.test(msg) || /not_found/i.test(msg)) return [];
      throw e;
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    return out;
  }

  async function downloadBlob(path) {
    const token = await ensureToken();
    if (!token) throw new Error("not signed in");
    const res = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Dropbox-API-Arg": JSON.stringify({ path }),
      },
    });
    if (!res.ok) throw new Error("download " + path + " " + res.status);
    return await res.blob();
  }

  function signOut() {
    Object.values(STORE).forEach((k) => localStorage.removeItem(k));
  }

  let callbackPromise = null;
  function maybeHandleCallback() {
    if (callbackPromise) return callbackPromise;
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const verifier = localStorage.getItem(STORE.VERIFIER);
    if (!code || !verifier) return Promise.resolve(false);
    callbackPromise = exchangeCode(code).then(() => {
      sessionStorage.setItem(STORE.JUST_CONNECTED, "1");
      const clean = location.origin + location.pathname + location.hash;
      history.replaceState(null, "", clean);
      return true;
    }).catch((e) => {
      console.warn("Dropbox auth failed:", e);
      try { history.replaceState(null, "", location.origin + location.pathname); } catch (_) {}
      return false;
    });
    return callbackPromise;
  }

  function consumeJustConnected() {
    const v = sessionStorage.getItem(STORE.JUST_CONNECTED);
    if (v) sessionStorage.removeItem(STORE.JUST_CONNECTED);
    return !!v;
  }

  window.DropboxSource = {
    APP_KEY,
    TRIPS_PATH,
    isAuthenticated,
    accountName,
    startOAuth,
    listTripFiles,
    downloadBlob,
    signOut,
    maybeHandleCallback,
    consumeJustConnected,
  };

  maybeHandleCallback();
})();
