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
  <title>flightlah is closed lah</title>
  <meta name="robots" content="noindex">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="flightlah">
  <meta property="og:title" content="flightlah">
  <meta property="og:description" content="Live departures and arrivals for Singapore Changi Airport, plus a live plane tracker.">
  <meta property="og:url" content="https://flightlah.com/">
  <meta property="og:image" content="https://flightlah.com/og.png?v=3">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="flightlah">
  <meta name="twitter:description" content="Live departures and arrivals for Singapore Changi Airport, plus a live plane tracker.">
  <meta name="twitter:image" content="https://flightlah.com/og.png?v=3">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      background: #0b0c0e; color: #ecebe7;
      font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 100vh; min-height: 100dvh; padding: 24px;
    }
    header { position: fixed; top: 0; left: 0; right: 0; padding: 16px 18px; line-height: 1.25; }
    header .brand { display: block; font-size: 17px; font-weight: 700; }
    header .sub2 { display: block; font-size: 12px; color: #8b9099; }
    main { width: 100%; max-width: 320px; text-align: center; }
    .tile {
      width: 84px; height: 84px; border-radius: 19px; margin: 0 auto 18px; display: block;
      background: #141619 url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAQAElEQVR4nOzdC3wU1b0H8N/MPrLvhFdeEAQUCCIK1wqIULUqoigfrGLVVr1qa69aS7FeEN/4qGK1Fa0Pqoha5VZvrSiCivoRhIooAooISFUgEBLCI9l3ssme/s8ACjHvnc3O7Py/n8+4k2RZop7fnMecOccOA8jJ8Q+w2XA0IAqgqoX0rQI6P/CqFECgUFHgBTMNIRCBggo6q6Qv6VWpRDJJr6CvlYqGBmyorQ19hQxTkCEej+cEKLbzqGCfR79GKZgFiY0C+CeSDa9Go9FVyIDODIDN5fONtgmcJ6BOpIJ/BBg7gGqMrQqSr1LN8Go8Hl5O30qiE3RGAPLcXv80VVGupvOuYKw1QuwSivJUNBx8iL7ahzRKZwDcXq9/MhRlGp3ngbH220dhmBmJhB6h8xjSIB0BsHs8vquo4N+uKEoxGEuREKKc/jEjGg0/Q1/WQ0d6BkBx+3yTVCh30+kAMKY78VUS4tZYOPwP+QV0oFcA/B6vfx5d8c8BY2lGNcIb0UjoEjoNIUUpB0CO4dsdeJ0+aiAY6zRiU30CE1K9l6AiBR5PYLzdoXzChZ91PmWgLHuyDCIFNnSM4vEFZlAKn6RmjwuMZUYOlcGLHTkuJVFXuxQd0JEmELf3meF0tF/QrgBwe58ZW/v7Be3pAyg2u/IIF35mXMpAKqMPox0X9jb3Adxe//2qolwOxgxMUdDf7nC66hN177bl/W0KgMfjv0pVlQfAmAlQ/3S03enYUF9Xt77V97b2BrfbP0pRsYQ+1AHGTII6xTEFyVGRSGRtS+9rMQBut7uXarOvprf1AGMmIwTKRDIxKhaLbW/uPS11gl2K6ljAhZ+ZFfUHSqgM06glmr1X1WwfgG503UofcBEYMzEqw0UOZ04D3Shb0uTPm/lzAa8vsI1ec8GY+VVHwsE+9FrT+AdNNoHo6n8DuPCz7JFHZXpKUz/4QQ3g9XoL6JbXJnAAWHZpshZoogZQpoMLP8s+TdYCh9UA8uovoG7hGZ7pc8JgDy4/pxuGD/GipMAhh+pQVpnAynVhPLtgL1ZviIKlTTVEwyC6N1Bx8BuNAuB7GIo6GUx3HpeK2bf1xnmndmnxfS8v3otr/7AN8TpdnvhjjYnkrEgk/LuDXx4aAAeN/Oym1wCYrrxuFe8/NQBH93O36f1rN0Yw+sqML5qWrWqoLyDvbSXkF9/1Aaj5cxq48KfFc3f1aXPhl4aWevHMnbxuWJrkHijrmu8CIBR1Ipjuzj8tD+NOav+YwoVju+Inw/1g6aCMO3j2/SiQ+P6bTD83XVmIjrr5qo7/WdYCpVEAnE5/Ka/Vqb8zRgYwqG/bmz6NjRziw7BSD5jelIGyzMszLQAOB7j5kwaXnNUFqbp4XOqfwX7oYJnXAkADbhyANJh0RuprAV9wOgcgHQ6WeZV6xLKhORxMV8cN6HjT51D5XR0o6GYH091wj8dTJGuAoXTnN2MbZWSrIf31CYA0+Ej9Povtp+x3HAVA5aGGNOhb7IRe+vXMAUsHtVDWrRyANHC7Ulp18jB5/o4u4MdaUage2IyO6SzHqV+rMtenX5jYoYSsAbgJlA5Ou36F1ufmGiA9VKoBFK4BjM7G5T89qOyrQih9wJg1cR+AWZlSaKexUB5jY1aVy8MLzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSOADM0jgAzNI4AMzSbE5nzp1gunE6gBsuLcCvzutO5/pcXwb0dmmvq76MoCEJpiPF6wsIMF1MPDUX917XE0cUp2ffwa3ltbj5Lzvw2pIaMH1wAHRQ2teFR6eV4MRjfegMKz4P4/qZZdj4bRwsNRyAFHTLs+GOq4vw3xO6Q1UVdKZkUuDZ13djxl93Yk91A1jHcAA6wGYDrp3UAzddUYhcvx2ZVBOqx/1zK/D4/1ehgXPQbhyAdjpzlB/3X98L/Y9wwUg2b41j2iPbsXhFCKztOABtNKB3Dv50YwlO+ZEfRrZkVQiTHyjD19trwVrHAWhFwKfi1l8W4eqf9oDd3rnt/I6qrxeY/UoV7p2zE8Ewj5u2hAPQDFUVuGpiD63wd8vLbDu/o3bvq8c9T+/EnPlVEMIc4e1sHIAmjB7qwywa1hxosHZ+R234JoYpD27H8rVhsMNxAA7Rp9iJ+67viXNPzkM2en1JtdZRLqtIgO3HASAel6INaf7monzdpi8YVW1dEn/5+y7MfLYC0Thf+yweAIFfjO+GGf9TjIJuDlhJ5Z4Ebn9iB15ctJe+sm7/wLIB+NHRHjw6rTeG9HfDytZsjFL/oAyrvozCiiwXgOIeDtz7m2JMOqMr2PdeWrwHNz9aTjVDPazEMgHIcSr4/aUFmPLzfLhdNrAfisYa8KcXd+HPL1RSX8Ea10VLBGDS6V1w93VF6FWQnmnK2aasoha3PlaOV96rRrbL6gAcc5RLa+efMNgL1n6frI/g+pnb8MW/s3fadVYGoEeeDXdd25NGeLpCUfgOaCrktOsXFu7BHU+UoyoLp11nVQDk44jX/SwfUy8vgN9rzukLRhWKyGnXlXjspV2oz6IcZE0AzvlxQLuL27dndkxfMKqvy2ox/dHtWLQ8iGxg+gDIxxH/fGMvjBlm7GnK2WbZmhAmzyzDV9vMPe3atAHoErDh9l8V4cqJ3WGzcTs/ExoaBJ6eX4V7nqrAvqA520WmC4B8HPHXP+2O6VcVUgisNX3BqPbW1OMPcyrw13/uok6zuS5GpgrAycf7MGtqCY4q4Xa+EW3aGscND5Zh6afmmXZtigAcWeLEzN/2wriTcsGMb9GyGkydtR1byutgdIYOgM+j4mZq6lxzQQ84snyacrapSyTxxMtVuG9uBcJR4z6WacgAKIrQ1tq5/eoi9OjC7Xwz27U3gRmzy/Hcgj0w4rRrwwVg5BCvtsraoH7WnqacbdZtjmnTrj9aF4GRGCYAJYUO3HNdMc4/zfzTlD/+IgKPW8ExR3qghy/+HdWe3hp+jPnnNL3y3l5Mf6Qc5VXGeCwz4wFwuxRMvawA119cAFeOOdv5chrx+6tCeIM6f4uW12hLFT4ytRfdo+gBPcx5tQqT/7hdW4px/JhcjB+di5+c4DfttO5YvAGz5u3CQy9U0nlmr78ZnDAjcPG4rrjrmmIU9XDCbGTb9k0q7LLQv/dxkDp9h/9cz0l4Bz9KBuv5BXu1Q857On1EQAvDWXTkdzVPX0kG96Yri3DZOd1w2+PleGnxPmRKxgKw/JmBGFpqrip9/dcxGuKrxpsfBqmZ0/IjhELod2Vr6qNk4OR8nP1zcsowYogHZ43aH4bBR5qj/1Sc78ScO/vg6vO747Rfb0YmZCwAZij88lb/h5+HsfCDGry2tLpdy4mkowZoycp1Ue24c/ZOrT818ZQ8nE3NpVHH+gw/VWTEkM5ZVr4pPGe4ETnt952VIe1Kv+hfQVMuLSiD+ujfq7Qjz2/DWScFcDbVDKeP8PM08Ub4vwbZsasOC5dXY+GyIJZSZzab5rtXhxrwf2/t0w479Znl4r6y3yBrh5755ut76c2yAfhsU4QKfZAKfQ0++yoGK5DBfpdqN3lMeWg7hg50UxioIz0mD8cO0GfI1mwsEwB5a37Z6pB2lZfteast/9GUtZti2nHvnEoUdbdjwsl52jDrmGE+y0w9yeoA7Asm8PaKkDY56+0VQURivFR4c3bursfsV3Zrh9etYtwo6jeMCeDMkbnIC2RvMcm6f7Nvd8S1po0s9MvXhkw3P90I5IVCLokiD/n8xejjfFqfQTaX+mTZI6emD4Acb1+1PkqFvkYr9F8etnMiF/5UyX3Hlq4Oa8e0WTswuJ/rQBhycfzRHtOvumHKAMRrk3j/k5BW6N+g4crd+3h3uM6y/pu4dvzxuUp072LDuT/O08IgR5fMOJXFNAGo2pfAWzQuL4cr5ShGvJaX9s40eeGZ+9oe7ZBzug5OzRhHd6S7dzFH0TL0b7lpS5xu9VdrV/qV6yK8zY+ByUltC5bWaId8nmMk3YHW7jfQMcDAO+0YKgBy6sFHn4e1GZXzl9Rg685DH6njwm8W8kK14rOIdsg1Rvv3dlIQ9jeVRh7r7fRNxVuS8QCEow14b2VwfyeWRm/knUuWXTZvq9OmP8tDLmdztrz5RoE4bbgfXk9mp3RnLAByjrss9Nm6sbNcU1MvIou6O3L9oBcX7dMOaeyJfq0jnSkZC4B8wCOb6VnNZ/P6vvICmMmLIC+1wCyNA8AsjQPALI0DwCyNA8AsjQPALI0DwCyNA8AsjQPALI0DwCyNA8AsjQPALI0DwCyNA8AsjQPALI0DkAZnjPTjgtO7QC+TzuiqfSbTn2l3ijciVRW465qe+N3PC6A3uf7Rwy9W4o4ny3mxLx1xAHSS39WOeff1xcg0r3X/0bowLpr2LXZX89qmeuAmkA5GHOPFyr+Vpr3wS/LvkH/XiCzYMM8IOAApmvKLfCx+on+n7mdc0M2Btx/vj8mX5IOlhptAHSR3sX/+7r4Ye2IAmbR4RRCX3fatoXdjNzIOQAcc3c+Flx/ohz7FOTCCLeW1uHDqN/jymzhY+3ATqJ0uO7crPpgz0DCFX5K/y7JnBtJwqX5Dr1bBNUAbOR0KnrylNy4ca+yd7J97fTemPFT2g32LWdNkAKrpNResWUcUObUmj1n235X7GZ9/49fYXskpaEUNNYFEBViz5DqWHz1faprCL8nfdeXfBvHd41aJCpvTmXMBVQR9wA4j7+rec21PPPT7EuQ4zddVctHv/LOxXeDOUbB0dYiXlm/aehVC4RqgCccN8GJyGqY0dCa5fdENlxbi2P7W3AK1VVT26dKW5AAwi0pW2Ok6wQFglpSEukUuj84BYNakaDWAbAJldpcOq5G74shdLt/6sEb7Wm4qd+oJfvjStFtKku/0NIn+s1TYhRCfabs6mX3DV4Pb8G0Miz8MajvWf/hZGPWH7AT13IK9sFPZH3WcD2eeGMDYUQEM6qvfsKuBtuQyDCr3Ih4Jf2qPRqM7PV7/x/S9EWC6idBVfsmnISz+KKht77pjV8s3pWQgPlgd1o5bHitHz3wHxp0UwJkjc3Hy8b6M76WVhWSZD2lbJNEFYj44ACn7amtcu8K/Q8eyNSEkUnhmRQZmzqt7tMNB/5fGDPNrNcOZIwPob+BtR83iQJnfv/eo0+kvdTiVDWDfGVbq0SaYtSQWb9Cu2G9T0+ZNas+XVXTO1AM5NWOcDAP1HcYM88Ltarl2GH3FRqzdFAP7XqJODKqrC23UagB54nD6N1EeBoK16Jvt8iofokJfQ4U/lJFJZ3L/5Nmv7NYOpwPURJJhoBqCaod+vbh2aJ3YJMu8PPt+l0gh3qJbhxyARmrrkli+JqRd5d+mNguPNAAAA1RJREFU9vzXZXUwEhnAd+j3kgc1nHBUiVPrSMva4aShPlNO40g3GhWbf/D8u/EBr9c7DortTTBNQTc7NYPcWPppmJo65hxHdLsUrQO9ZmMMlXv4IfqDGpA8NR4OL5Hnhw6QOby+QBV4ajTLbsFIONidXrXG66H1YyIpxJNgLItRGX8CBwq/1PgWSYBqgW3gWoBlJ3n170Wv321N37iHFKTO8P1gLBsJcR8OKfxSUzfJc+jO8BZFUQrBWLYQYlckEupNZ7WHfrupMbJaevMMMJZFhBB3oFHhl5qbJqV6fIHN9MN+YMzkhMCWaCR4JOQjAI00d5eE7hUkbwFjWUAoyeloovBLzU4iqa+r+8LpyBlAdcQQMGZWAvOikdBdzf24tZnibq/Pv5reVgrGTEdsjIRD/0Unzc4EbG2iSKw+gYn0WgPGzKXmQNltcRpsqzOlamtDm0QSl1AvmpcfZqYgy6oss7LstvbeNj1mlEjUbnbkuOSTdaeAMYOjcnpzNBqa28b3tv1z6QbZArpBNh6MGRRd/RdSp/ectr6/vY9LB6hTvJI7xcyYtE6vfLQ32NY/0d6nJYL0FwynoaV3wZiRUJnUymY7Cr/UkaUG6qhPMM/ucOZQc2g0GMuwpBAPULPnCjpt9xY5Ka0Y4/J6L1GhzqUgOMFYJ6P2fl0SySvikcg8dFDKSya53f4TFRX/oBAUg7FOQoW/nIY6L4jFQiuQAl3WDPN4PEVQ7AsVBcPAWJoJgTUQ9ePlom5IkS7LjSUSiTD1C+Y6nI4K6owMo9qAtyZhuqOr/k4oYjq196+lMqfL7IR0rBrpdnv919Bds5vo43uAsZSJ3UmB+2OR0ONoZWpDe6Vz2VSfx+P/raIq/0vneWCs/apFMvlgNBqeRedhpEFnrBucRzXCNKoRfkl/XXcw1irtiv80XfFn0hfVSKPOXDhbdbsDwxVVTKC/dAIUZTAYO0iI9UlgAZJ4nUZ2VqKZB1j0lrGV410u1xGKzXE+1QwTqFc/mjrOvP63hVCHNqFA+UAWetFQNz8ej29FBhhl6wQHBaIEdntvm1BLhEj2hqqUQCi9FYgSqi3k0/wBMDORS+xsE1DKaORmG92uLVMUdVuDkiwTiURZbW2tXH8q4zt5/wcAAP///Ao4MQAAAAZJREFUAwDVanDGv5ByQAAAAABJRU5ErkJggg==") center/cover;
      border: 1px solid #24272c;
    }
    h1 { font-size: 22px; margin: 0 0 22px; }
    h1 .y { color: #ffd23f; }
    form { display: flex; gap: 8px; }
    input {
      flex: 1; min-width: 0; padding: 12px 14px; border-radius: 10px;
      border: 1px solid #24272c; background: #141619; color: #ecebe7; font: inherit;
    }
    input:focus { outline: 2px solid #ffd23f; outline-offset: 1px; }
    button {
      padding: 12px 18px; border: 0; border-radius: 10px; cursor: pointer;
      background: #ffd23f; color: #0b0c0e; font: inherit; font-weight: 600;
    }
    .err { color: #ff5a5f; margin: 12px 0 0; min-height: 1.2em; }
    footer { position: fixed; bottom: 18px; left: 0; right: 0; text-align: center; color: #5d626b; font-size: 12px; letter-spacing: 0.08em; }
  </style>
</head>
<body>
  <header><span class="brand">flightlah</span><span class="sub2">SIN · T1-T4</span></header>
  <main>
    <span class="tile" role="img" aria-label="flightlah logo"></span>
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
