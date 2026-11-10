// flightlah service worker: makes the app installable and gives it an offline fallback.
//
//   App files (page, script, styles, icons, Leaflet): network first, so a deploy shows
//     up on the next load; the cached copy is used only when the network fails.
//   GET .../api/board:  network first; the last good answer per URL is kept, and served
//     offline with `offline: true` and `offlineAt` added so the page can say so.
//   Everything else (aircraft positions, map tiles, other sites): straight to the
//     network, never cached. Positions are useless when old; tiles are OSM's.
//
// Bump VERSION when the list of app files changes; old caches are removed on activate.

const VERSION = "v1";
const SHELL = `flightlah-shell-${VERSION}`;
const DATA = `flightlah-data-${VERSION}`;
const SHELL_FILES = [
  "./", "index.html", "app.js", "style.css", "config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];
const LEAFLET = /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/1\.9\.4\//;
const NETWORK_TIMEOUT_MS = 6000; // a stalled airport Wi-Fi counts as offline after this

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
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
async function board(req) {
  const cache = await caches.open(DATA);
  const key = req.url; // cache by URL only (no headers), so any copy of this board matches
  try {
    const res = await fetchWithTimeout(req);
    if (res.ok) {
      const body = await res.clone().json();
      await cache.put(key, new Response(JSON.stringify({ ...body, savedAt: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      }));
    }
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (!hit) throw err;
    const body = await hit.json();
    return new Response(JSON.stringify({ ...body, offline: true, offlineAt: body.savedAt || null }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.endsWith("/api/board")) { e.respondWith(board(req)); return; }
  if (url.pathname.includes("/api/")) return; // traffic: live only
  if (url.origin === self.location.origin || LEAFLET.test(req.url)) { e.respondWith(shell(req)); return; }
  // Map tiles and anything else: not handled here.
});
