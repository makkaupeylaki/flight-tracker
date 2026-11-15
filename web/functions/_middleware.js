// flightlah shared-password gate (Pages Functions middleware, runs on
// flightlah.com and flightlah.pages.dev). When the GATE_PASSWORD secret is
// set on the Pages project, every page and asset sits behind the lock screen
// until the right password sets the fl_gate cookie. The same secret on the
// changi-board Worker locks the API; the same cookie opens it once
// flightlah.com/api/* is routed to the Worker. Delete the secret to open the
// site again - no redeploy needed. Keep the cookie code in sync with
// worker/src/gate.js.

const COOKIE_NAME = "fl_gate";
const MAX_AGE_MS = 12 * 3600e3; // hard cap; the cookie itself is a session cookie

// Identity assets only (no data): iOS fetches the Home Screen icon and PWA
// manifest without the gate cookie, so these stay public or the icon falls
// back to a letter tile.
const OPEN_PATHS = new Set([
  "/manifest.webmanifest",
  "/og.png",
  "/apple-touch-icon.png",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
]);

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gateCookieValue(secret, now = Date.now()) {
  const exp = now + MAX_AGE_MS;
  return `${exp}.${await hmacHex(secret, `fl-gate:${exp}`)}`;
}

async function gateCookieOk(request, secret, now = Date.now()) {
  const raw = request.headers.get("Cookie") || "";
  const pair = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!pair) return false;
  const [exp, sig] = pair.slice(COOKIE_NAME.length + 1).split(".");
  if (!/^\d+$/.test(exp || "") || !sig || sig.length !== 64) return false;
  if (Number(exp) < now) return false;
  return sig === (await hmacHex(secret, `fl-gate:${exp}`));
}

function lockPage(error) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <script>
    // Same theme choice as the app (no flash): Legacy unless Classic was chosen on this device.
    (function(){try{var t=localStorage.getItem('flightlah-theme');document.documentElement.dataset.theme=(t==='classic')?'classic':'legacy';}catch(e){document.documentElement.dataset.theme='legacy';}})();
  </script>
  <title>flightlah is closed lah</title>
  <meta name="robots" content="noindex">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="flightlah">
  <meta property="og:title" content="flightlah">
  <meta property="og:description" content="Live departures and arrivals for Singapore Changi Airport, plus a live plane tracker.">
  <meta property="og:url" content="https://flightlah.com/">
  <meta property="og:image" content="https://flightlah.com/og.png?v=5">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="flightlah">
  <meta name="twitter:description" content="Live departures and arrivals for Singapore Changi Airport, plus a live plane tracker.">
  <meta name="twitter:image" content="https://flightlah.com/og.png?v=5">
  <style>
    /* Legacy (default): green-black + lime. Classic: the original colours, unchanged. */
    :root {
      --bg: #0a100e; --accent: #a3e61a; --ink: #f3f6f4; --muted: #9daaa3; --faint: #68766d;
      --field: #101915; --border: #27342e; --btn-ink: #0a100e; --err: #ff8f7a;
    }
    [data-theme="classic"] {
      --bg: #0b0c0e; --accent: #ffd23f; --ink: #ecebe7; --muted: #8b9099; --faint: #5d626b;
      --field: #141619; --border: #24272c; --btn-ink: #0b0c0e; --err: #ff5a5f;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      background: var(--bg); color: var(--ink);
      font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 100vh; min-height: 100dvh; padding: 24px;
    }
    header { position: fixed; top: 0; left: 0; right: 0; padding: 16px 18px; line-height: 1.25; }
    header .brand { display: block; font-size: 17px; font-weight: 700; }
    header .sub2 { display: block; font-size: 12px; color: var(--muted); }
    main { width: 100%; max-width: 320px; text-align: center; }
    .tile {
      width: 84px; height: 84px; border-radius: 19px; margin: 0 auto 18px;
      display: flex; align-items: center; justify-content: center;
      background: var(--field); color: var(--accent);
      border: 1px solid var(--border);
    }
    h1 { font-size: 22px; margin: 0 0 22px; }
    h1 .y { color: var(--accent); }
    form { display: flex; gap: 8px; }
    input {
      flex: 1; min-width: 0; padding: 12px 14px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--field); color: var(--ink); font: inherit;
    }
    input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    button {
      padding: 12px 18px; border: 0; border-radius: 10px; cursor: pointer;
      background: var(--accent); color: var(--btn-ink); font: inherit; font-weight: 600;
    }
    .err { color: var(--err); margin: 12px 0 0; min-height: 1.2em; }
    footer { position: fixed; bottom: 18px; left: 0; right: 0; text-align: center; color: var(--faint); font-size: 12px; letter-spacing: 0.08em; }
  </style>
</head>
<body>
  <header><span class="brand">flightlah</span><span class="sub2">SIN · T1-T4</span></header>
  <main>
    <span class="tile" role="img" aria-label="flightlah logo"><svg viewBox="0 0 32 32" width="80" height="80" aria-hidden="true"><path fill="currentColor" d="M16 4c1 0 1.6 1 1.6 2.4V13l9.4 5.4v2.4l-9.4-2.9v5.6l2.6 2v1.9L16 26.2l-4.2 1.2v-1.9l2.6-2v-5.6L5 20.8v-2.4l9.4-5.4V6.4C14.4 5 15 4 16 4z"/></svg></span>
    <h1>flightlah is <span class="y">closed</span> lah</h1>
    <form method="post" action="/_gate">
      <input type="password" name="password" autocomplete="current-password" autofocus aria-label="Password" placeholder="Password">
      <button type="submit">Open</button>
    </form>
    <p class="err">${error || ""}</p>
  </main>
  <footer>LUQ TECH.</footer>
</body>
</html>`;
}

/**
 * Lock page status: 200 for navigation-like paths (no file extension) so chat
 * crawlers (WhatsApp/iMessage) build the link preview from the og tags above;
 * 401 for asset-like paths so nothing caches this HTML as app.js/style.css.
 * The gate itself is unchanged: assets stay 401 and the API stays 401 JSON.
 */
function lockResponse(request, error) {
  const hasExt = /\.[a-z0-9]+$/i.test(new URL(request.url).pathname);
  return new Response(lockPage(error), {
    status: hasExt ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  if (!env.GATE_PASSWORD) return next();

  const url = new URL(request.url);
  if (url.pathname === "/_gate") {
    if (request.method !== "POST") return lockResponse(request);
    let password = "";
    try {
      password = String((await request.formData()).get("password") || "");
    } catch {
      return lockResponse(request, "Something went wrong. Try again.");
    }
    if (password === env.GATE_PASSWORD) {
      const value = await gateCookieValue(env.GATE_PASSWORD);
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store",
        },
      });
    }
    return lockResponse(request, "Wrong password. Try again.");
  }

  if (OPEN_PATHS.has(url.pathname)) return next();
  if (await gateCookieOk(request, env.GATE_PASSWORD)) return next();
  return lockResponse(request);
}
