// Changi Board Worker: cron fetcher + JSON API.
//
//   cron */10      -> fetch today's board, write to KV only when it changes
//   GET /api/board -> today's board from KV (?date=yyyy-MM-dd for other days)
//   GET /api/traffic -> live aircraft near Changi (ADS-B), cached ~10 s

import { fetchBoard, sgtToday, addDays } from "./changi.js";
import { fetchTraffic, fetchCallsign, normaliseArea, normaliseCallsign } from "./traffic.js";

const BOARD_TTL_S = 4 * 86400; // keep a few days of boards in KV
const HEARTBEAT_MS = 30 * 60e3; // rewrite unchanged board at most every 30 min
const STALE_MS = 45 * 60e3; // board older than this is flagged stale
const OTHER_DATE_CACHE_S = 300; // live fetches for non-today dates
const TODAY_CACHE_S = 30;
const TRAFFIC_CACHE_S = 10;
const DATE_WINDOW_DAYS = 7; // ?date must be within +-7 days of today

const boardKey = (date) => `board:${date}`;
const STATUS_KEY = "status";

// ---------------------------------------------------------------- helpers

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin");
  let allow = "*";
  if (!allowed.includes("*")) allow = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(data, { status = 200, maxAge = 0, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      ...headers,
    },
  });
}

// Per-isolate memo, on top of the Cache API (which is a no-op on *.workers.dev).
const memo = new Map();
function memoGet(key, maxAgeMs) {
  const hit = memo.get(key);
  return hit && Date.now() - hit.at < maxAgeMs ? hit.value : null;
}
function memoSet(key, value) {
  memo.set(key, { at: Date.now(), value });
  if (memo.size > 50) memo.delete(memo.keys().next().value);
}

async function cached(ctx, key, ttlS, produce) {
  const m = memoGet(key, ttlS * 1000);
  if (m) return m;
  const cacheKey = new Request(`https://changi-board.internal/${key}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const value = await hit.json();
    memoSet(key, value);
    return value;
  }
  const value = await produce();
  memoSet(key, value);
  ctx.waitUntil(
    cache.put(cacheKey, new Response(JSON.stringify(value), { headers: { "Cache-Control": `max-age=${ttlS}` } }))
  );
  return value;
}

// ---------------------------------------------------------------- board

/**
 * Fetch a date's board and write it to KV only if it changed (or the stored
 * copy is older than HEARTBEAT_MS, so "last updated" stays meaningful).
 * Returns { written, board }.
 */
export async function refreshBoard(env, date) {
  const { dep, arr } = await fetchBoard(date);
  const hash = await sha256(JSON.stringify({ dep, arr }));
  const prev = await env.BOARD_KV.get(boardKey(date), "json");
  const now = Date.now();
  if (prev && prev.hash === hash && now - prev.updatedAt < HEARTBEAT_MS) {
    return { written: false, board: prev };
  }
  const board = {
    date,
    updatedAt: now,
    changedAt: prev && prev.hash === hash ? prev.changedAt || prev.updatedAt : now,
    hash,
    dep,
    arr,
  };
  await env.BOARD_KV.put(boardKey(date), JSON.stringify(board), { expirationTtl: BOARD_TTL_S });
  return { written: true, board };
}

async function setStatus(env, ok, error) {
  const prev = await env.BOARD_KV.get(STATUS_KEY, "json");
  // Only write on transitions to keep KV writes low.
  if (ok && (!prev || prev.ok)) return;
  if (!ok && prev && !prev.ok) return;
  await env.BOARD_KV.put(
    STATUS_KEY,
    JSON.stringify(ok ? { ok: true, at: Date.now() } : { ok: false, error: String(error), since: Date.now() })
  );
}

async function runCron(env) {
  const now = Date.now();
  const today = sgtToday(now);
  const dates = [today];
  // Just after midnight SGT, keep finishing yesterday's board (late arrivals).
  const sgtHour = new Date(now + 8 * 3600e3).getUTCHours();
  if (sgtHour < 2) dates.push(addDays(today, -1));

  let error = null;
  for (const date of dates) {
    try {
      const { written, board } = await refreshBoard(env, date);
      console.log(`board ${date}: ${board.dep.length} dep, ${board.arr.length} arr, ${written ? "written" : "unchanged"}`);
    } catch (e) {
      console.error(`board ${date} failed: ${e.message}`);
      if (date === today) error = e;
    }
  }
  await setStatus(env, !error, error && error.message);
}

function present(board, { source, error, status }) {
  const age = Date.now() - board.updatedAt;
  const failing = status && status.ok === false;
  return {
    date: board.date,
    updatedAt: board.updatedAt,
    source,
    stale: Boolean(error) || failing || age > STALE_MS,
    error: error || (failing ? status.error : null),
    dep: board.dep,
    arr: board.arr,
  };
}

async function handleBoard(request, env, ctx, url) {
  const today = sgtToday();
  const date = url.searchParams.get("date") || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < addDays(today, -DATE_WINDOW_DAYS) || date > addDays(today, DATE_WINDOW_DAYS)) {
    return json({ error: `date must be yyyy-MM-dd within ${DATE_WINDOW_DAYS} days of today` }, { status: 400 });
  }

  if (date === today) {
    const body = await cached(ctx, `board-today-${date}`, TODAY_CACHE_S, async () => {
      const [board, status] = await Promise.all([
        env.BOARD_KV.get(boardKey(date), "json"),
        env.BOARD_KV.get(STATUS_KEY, "json"),
      ]);
      if (board) return present(board, { source: "kv", status });
      // Cold start (cron hasn't run yet): fetch now and seed KV.
      const { board: fresh } = await refreshBoard(env, date);
      return present(fresh, { source: "live" });
    });
    return json(body, { maxAge: TODAY_CACHE_S });
  }

  // Other dates: fetch live, cache briefly, fall back to whatever KV has.
  try {
    const body = await cached(ctx, `board-live-${date}`, OTHER_DATE_CACHE_S, async () => {
      const { dep, arr } = await fetchBoard(date);
      return present({ date, updatedAt: Date.now(), dep, arr }, { source: "live" });
    });
    return json(body, { maxAge: OTHER_DATE_CACHE_S });
  } catch (e) {
    const board = await env.BOARD_KV.get(boardKey(date), "json");
    if (board) return json(present(board, { source: "kv", error: e.message }), { maxAge: 60 });
    return json({ error: `Flight data unavailable: ${e.message}` }, { status: 502 });
  }
}

// ---------------------------------------------------------------- traffic

// Last good answer per area/callsign, kept in this isolate's memory only (never KV),
// so a brief upstream outage or rate limit can still be answered as "stale".
const lastTraffic = new Map();
function rememberTraffic(key, body) {
  lastTraffic.set(key, body);
  if (lastTraffic.size > 50) lastTraffic.delete(lastTraffic.keys().next().value);
}

/**
 * GET /api/traffic                         aircraft within 25 nm of Changi
 * GET /api/traffic?lat=&lon=&dist=         aircraft around a map centre (dist in nm, max 250)
 * GET /api/traffic?callsign=SIA322         one flight wherever it is
 * Fetched live from adsb.lol (fallback airplanes.live); cached ~10 s in memory
 * and via HTTP cache headers. Nothing is written to KV.
 */
async function handleTraffic(request, env, ctx, url) {
  const q = url.searchParams;
  let key, area = null, callsign = null;
  try {
    if (q.has("callsign")) {
      callsign = normaliseCallsign(q.get("callsign"));
      key = `callsign-${callsign}`;
    } else {
      area = normaliseArea(q.get("lat"), q.get("lon"), q.get("dist"));
      key = `traffic-${area.lat},${area.lon},${area.dist}`;
    }
  } catch (e) {
    return json({ error: e.message }, { status: 400 });
  }

  try {
    const body = await cached(ctx, key, TRAFFIC_CACHE_S, async () => ({
      ...(callsign ? await fetchCallsign(callsign) : await fetchTraffic(area)),
      ...(callsign ? { callsign } : { area }),
      at: Date.now(),
    }));
    rememberTraffic(key, body);
    return json(body, { maxAge: TRAFFIC_CACHE_S });
  } catch (e) {
    const last = lastTraffic.get(key);
    if (last && Date.now() - last.at < 120e3) {
      return json({ ...last, stale: true }, { maxAge: 5 });
    }
    return json({ error: `Traffic unavailable: ${e.message}`, ac: [] }, { status: 502 });
  }
}

// ---------------------------------------------------------------- entry

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, { status: 405, headers: cors });

    let res;
    try {
      if (url.pathname === "/api/board") res = await handleBoard(request, env, ctx, url);
      else if (url.pathname === "/api/traffic") res = await handleTraffic(request, env, ctx, url);
      else if (url.pathname === "/" || url.pathname === "/api") {
        res = json({ name: "changi-board", endpoints: ["/api/board", "/api/board?date=yyyy-MM-dd", "/api/traffic"] });
      } else res = json({ error: "Not found" }, { status: 404 });
    } catch (e) {
      console.error(e);
      res = json({ error: e.message || "Internal error" }, { status: 500 });
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};
