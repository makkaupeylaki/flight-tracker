import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { gateCookieValue, gateCookieOk, gateLocked } from "../src/gate.js";
import { onRequest } from "../../web/functions/_middleware.js";
import { makeKV, installCaches, makeCtx } from "./harness.js";

installCaches();

// A made-up value for tests only. The real password lives only in the Cloudflare
// GATE_PASSWORD secret and must never appear in this repo.
const TEST_SECRET = "test-only-not-a-real-password";
const H = 3600e3;

const gatedEnv = () => ({ BOARD_KV: makeKV(), ALLOWED_ORIGINS: "https://flightlah.com", GATE_PASSWORD: TEST_SECRET });
const req = (path, { cookie, method = "GET", origin = "https://flightlah.com" } = {}) =>
  new Request(`https://flightlah.com${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin } });

test("gate off: no GATE_PASSWORD means no gate", async () => {
  const env = { BOARD_KV: makeKV(), ALLOWED_ORIGINS: "*" };
  const res = await worker.fetch(req("/api"), env, makeCtx());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, "changi-board");
  assert.equal(await gateLocked(req("/api"), env), false);
});

test("gate on: every route answers 401 JSON without the cookie (CORS headers kept)", async () => {
  const env = gatedEnv();
  globalThis.fetch = async () => { throw new Error("upstream must not be called while locked"); };
  for (const path of ["/api/board", "/api/board?airport=xsp", "/api/traffic", "/", "/api"]) {
    const res = await worker.fetch(req(path), env, makeCtx());
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: "flightlah is closed" }, path);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://flightlah.com", path);
  }
});

test("gate on: a valid cookie opens the API", async () => {
  const env = gatedEnv();
  const cookie = `other=1; fl_gate=${await gateCookieValue(TEST_SECRET)}; theme=dark`;
  const res = await worker.fetch(req("/api", { cookie }), env, makeCtx());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, "changi-board");
});

test("gate on: a cookie signed with a different password is rejected", async () => {
  const env = gatedEnv();
  const cookie = `fl_gate=${await gateCookieValue("some-other-password")}`;
  assert.equal((await worker.fetch(req("/api", { cookie }), env, makeCtx())).status, 401);
});

test("gate on: cookies expire after the 12 h cap", async () => {
  const now = Date.now();
  const fresh = await gateCookieValue(TEST_SECRET, now);
  const withCookie = (v) => req("/api", { cookie: `fl_gate=${v}` });
  assert.equal(await gateCookieOk(withCookie(fresh), TEST_SECRET, now + 11.9 * H), true, "still valid just under 12 h");
  assert.equal(await gateCookieOk(withCookie(fresh), TEST_SECRET, now + 12.1 * H), false, "expired just over 12 h");
  const old = await gateCookieValue(TEST_SECRET, now - 13 * H); // minted 13 h ago
  assert.equal((await worker.fetch(withCookie(old), gatedEnv(), makeCtx())).status, 401);
});

test("gate on: malformed or tampered cookies are rejected", async () => {
  const env = gatedEnv();
  const good = await gateCookieValue(TEST_SECRET);
  const [exp, sig] = good.split(".");
  const bad = [
    "fl_gate=", "fl_gate=abc", `fl_gate=${exp}`, `fl_gate=${exp}.`, `fl_gate=.${sig}`,
    `fl_gate=${exp}.${sig.slice(0, 63)}`, `fl_gate=${exp}.${sig}x`, `fl_gate=x${exp}.${sig}`,
    `fl_gate=${Number(exp) + 3600e3}.${sig}`, // later expiry with the old signature
    `xfl_gate=${good}`, `fl_gate2=${good}`, `other=${good}`,
  ];
  for (const cookie of bad) {
    assert.equal((await worker.fetch(req("/api", { cookie }), env, makeCtx())).status, 401, cookie);
  }
});

test("gate on: OPTIONS preflight and the cron stay open", async () => {
  const env = gatedEnv();
  const pre = await worker.fetch(req("/api/board", { method: "OPTIONS" }), env, makeCtx());
  assert.equal(pre.status, 204);
  globalThis.fetch = async (url) => (String(url).includes("seletarairport.com")
    ? Response.json([])
    : Response.json({ data: { getFlights: { next_token: null, flights: [] } } }));
  const ctx = makeCtx();
  await worker.scheduled({}, env, ctx); await ctx.drain();
  assert.ok(env.BOARD_KV.writes > 0, "cron still refreshes the boards while gated");
});

// ---------------------------------------------------------------- Pages middleware

const next = async () => new Response("the app", { status: 200 });
const page = (path, { env = { GATE_PASSWORD: TEST_SECRET }, method = "GET", cookie, body } = {}) =>
  onRequest({ env, next, request: new Request(`https://flightlah.com${path}`, { method, body, headers: cookie ? { Cookie: cookie } : {} }) });

test("middleware: off without the secret; lock screen without the cookie", async () => {
  assert.equal(await (await page("/", { env: {} })).text(), "the app");
  // Pages (no file extension) get the lock screen with 200, so chat apps still build
  // link previews; assets (with an extension) get 401 so nothing caches it as JS/CSS.
  for (const [path, status] of [["/", 200], ["/about", 200], ["/?flight=SQ1", 200], ["/app.js", 401], ["/style.css?v=1", 401], ["/icons/other.png", 401]]) {
    const res = await page(path);
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const html = await res.text();
    assert.match(html, /flightlah is <span class="y">closed<\/span> lah/);
    assert.ok(!html.includes("__ICON192_BASE64__"), "icon placeholder replaced");
    assert.ok(!html.includes(TEST_SECRET));
  }
});

test("middleware: identity assets stay public (icons, manifest, og image)", async () => {
  for (const path of ["/manifest.webmanifest", "/og.png", "/icons/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"]) {
    assert.equal((await page(path)).status, 200, path);
  }
});

test("middleware: unlock with the right password sets a session cookie the Worker accepts", async () => {
  const form = (pw) => new URLSearchParams({ password: pw });
  const wrong = await page("/_gate", { method: "POST", body: form("nope") });
  assert.equal(wrong.status, 200, "lock screen again (a page path, so 200)");
  assert.ok(!wrong.headers.get("Set-Cookie"), "no cookie for a wrong password");
  assert.match(await wrong.text(), /Wrong password\. Try again\./);
  const get = await page("/_gate");
  assert.equal(get.status, 200, "GET /_gate shows the lock screen");
  assert.ok(!get.headers.get("Set-Cookie"));

  const ok = await page("/_gate", { method: "POST", body: form(TEST_SECRET) });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("Location"), "/");
  const setCookie = ok.headers.get("Set-Cookie");
  assert.match(setCookie, /^fl_gate=\d+\.[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.ok(!/max-age|expires/i.test(setCookie), "session cookie: no Max-Age/Expires");

  const cookie = setCookie.split(";")[0];
  assert.equal(await (await page("/", { cookie })).text(), "the app", "the page opens with the cookie");
  const api = await worker.fetch(req("/api", { cookie }), gatedEnv(), makeCtx());
  assert.equal(api.status, 200, "the same cookie opens the Worker API");
});
