// flightlah service worker: makes the app installable and gives it an offline fallback.
//
//   App files (page, script, styles, icons, Leaflet): network first, so a deploy shows
//     up on the next load; the cached copy is used only when the network fails.
//   GET .../api/board:  network first; the last good answer per URL is kept, and served
//     (with `offline: true` and `offlineAt`) when the network fails or is slower than
//     NETWORK_TIMEOUT_MS. A slow answer still lands later and the page is told.
//   Everything else (aircraft positions, map tiles, other sites): straight to the
//     network, never cached. Positions are useless when old; tiles are OSM's.
//
// Bump VERSION when the list of app files changes; old caches are removed on activate.
//
// Release tokens: whenever style.css or app.js changes, change its ?v= token so
// browsers, the edge and this cache can't serve an old copy (the token is the first
// 7 hex digits of the file's sha256):
//   style.css: index.html and about.html (<link rel="stylesheet" href="/style.css?v=...">)
//              and SHELL_FILES below
//   app.js:    index.html (<script src="/app.js?v=...">) and SHELL_FILES below
// The cache key in SHELL_FILES must match the URL the pages request.

const VERSION = "v2";
const SHELL = `flightlah-shell-${VERSION}`;
const DATA = `flightlah-data-${VERSION}`;
const SHELL_FILES = [
  "./", "index.html", "/app.js?v=2a5f071", "/style.css?v=20d5df7", "config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];
// Extra pages, cached best-effort so a missing one never blocks the install.
// "about" is the /about URL Pages serves for about.html.
const EXTRA_PAGES = ["about"];
const LEAFLET = /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/1\.9\.4\//;
const NETWORK_TIMEOUT_MS = 6000; // a stalled airport Wi-Fi counts as offline after this

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll(SHELL_FILES).then(() => Promise.all(EXTRA_PAGES.map((p) => c.add(p).catch(() => {})))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("flightlah-") && key !== SHELL && key !== DATA) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/** fetch() that gives up after NETWORK_TIMEOUT_MS. */
function fetchWithTimeout(req) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

/** App files: network first, keep a copy, fall back to the copy. */
async function shell(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetchWithTimeout(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
    if (hit) return hit;
    if (req.mode === "navigate") return (await cache.match("index.html")) || Response.error();
    throw err;
  }
}

/** Board data: network first; offline, the last good answer marked `offline`. */
/**
 * Board data: network first. If the network fails, or hasn't answered within
 * NETWORK_TIMEOUT_MS, the last good copy is served (marked `offline`). A slow
 * request is NOT cancelled: when it does arrive it's saved, and open pages get a
 * "board-fresh" message so they can swap the fresh board in.
 */
async function board(e) {
  const req = e.request;
  const cache = await caches.open(DATA);
  const key = req.url; // cache by URL only (no headers), so any copy of this board matches
  const network = fetch(req).then(async (res) => {
    if (res.ok) {
      const body = await res.clone().json();
      await cache.put(key, new Response(JSON.stringify({ ...body, savedAt: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      }));
    }
    return res;
  });
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve("slow"), NETWORK_TIMEOUT_MS); });
  try {
    const first = await Promise.race([network, slow]);
    if (first !== "slow") return first; // answered in time
  } catch {
    // Failed outright (no connection): use the saved copy below.
  } finally {
    clearTimeout(timer);
  }
  const hit = await cache.match(key);
  if (!hit) return network; // nothing saved yet: keep waiting for the network (or its error)
  const body = await hit.json();
  e.waitUntil(network.then(async (res) => {
    if (!res.ok) return;
    // Send the fresh board itself (just saved above), so the page needn't fetch it again.
    const fresh = await (await cache.match(key)).json();
    for (const client of await self.clients.matchAll({ type: "window" })) {
      client.postMessage({ type: "board-fresh", url: key, body: fresh });
    }
  }).catch(() => { /* still offline: nothing to tell */ }));
  return new Response(JSON.stringify({ ...body, offline: true, offlineAt: body.savedAt || null }), {
    headers: { "Content-Type": "application/json" },
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.endsWith("/api/board")) { e.respondWith(board(e)); return; }
  if (url.pathname.includes("/api/")) return; // traffic: live only
  if (url.origin === self.location.origin || LEAFLET.test(req.url)) { e.respondWith(shell(req)); return; }
  // Map tiles and anything else: not handled here.
});
