// Seletar Airport (WSSL / XSP) flight board.
//
// Source: the airport website's public JSON, one call per direction and day:
//   GET https://www.seletarairport.com/content/seletarAirport/flightInfo/items.json
//       ?flightType=D|A&from=yyyyMMdd000000&to=yyyyMMdd235959   (Singapore time)
// No auth, no CORS (so it's fetched here, by the cron), and an empty User-Agent
// gets a 403. The endpoint returns 404 at random for about a minute, so each
// request is retried a couple of times; a failed day keeps its last good copy.

import { addDays, sgtToday } from "./changi.js";

const BASE = "https://www.seletarairport.com/content/seletarAirport/flightInfo/items.json";
const UA = "flightlah/1.0 (+https://flightlah.pages.dev)";

export const XSP_KEY = "xsp:board"; // one KV snapshot: yesterday, today, tomorrow and the fetch status
export const XSP_DAYS = [-1, 0, 1];

export const XSP_RETRIES = 2; // 3 attempts in all
export const XSP_BACKOFF_MS = 12e3; // ~15 s between attempts, kept inside the run budget below
export const XSP_RUN_BUDGET_MS = 26e3; // don't start a wait that would end after this
const ATTEMPT_TIMEOUT_MS = 8e3;

/** "2026-11-10" + "D" -> the day's URL (00:00:00 to 23:59:59 SGT). */
export function xspUrl(type, date) {
  const d = date.replace(/-/g, "");
  return `${BASE}?flightType=${type}&from=${d}000000&to=${d}235959`;
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
/** "2026-11-10 08:30:00" -> "2026-11-10 08:30", or null. */
const ts = (v) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str(v)) ? str(v).slice(0, 16) : null);
/** "DOOR A" -> "Door A". */
const door = (v) => str(v).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) || null;

/**
 * One Seletar row -> the board's Flight shape (same field names as Changi's, so the
 * page can share the row code). `et`/`ets` is BEST_DATE_TIME, the airport's current
 * best time (actual once departed/landed); if it's blank, the actual then estimated
 * time. `status` is REM_BLI as published (may be empty before the day's updates).
 */
export function normaliseXsp(r, dir) {
  const sched = ts(r.STD_DATE_TIME);
  if (!sched) return null;
  const best = ts(r.BEST_DATE_TIME) || ts(r.ATD_DATE_TIME) || ts(r.ETD_DATE_TIME);
  const status = str(r.REM_BLI);
  return {
    apt: "XSP",
    fn: str(r.FNR).toUpperCase().replace(/\s+/g, ""),
    al: str(r.AIRLINE_CODE) || null,
    an: str(r.AIRLINE) || null,
    ap: str(r.CITY_CODE) || null,
    city: str(r.CITY) || str(r.CITY_CODE) || null,
    cc: str(r.COUNTRY) || null,
    t: null,
    d: sched.slice(0, 10),
    st: sched.slice(11, 16),
    et: best ? best.slice(11, 16) : null,
    ets: best,
    door: dir === "dep" ? door(r.GATE) : null,
    belt: dir === "arr" ? str(r.BELT) || null : null,
    status,
    raw: status,
  };
}

const sortKey = (f) => `${f.ets || `${f.d} ${f.st}`}|${f.fn}`;

async function fetchList(type, date, { fetchImpl = fetch, timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(xspUrl(type, date), {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error("unexpected response");
  const dir = type === "D" ? "dep" : "arr";
  return body
    .map((r) => (r && typeof r === "object" ? normaliseXsp(r, dir) : null))
    .filter((f) => f && f.fn && f.d === date)
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One list with retries: at most `retries` more attempts, `backoffMs` apart, before `deadline`. */
async function fetchListRetrying(type, date, { retries = XSP_RETRIES, backoffMs = XSP_BACKOFF_MS, deadline = Infinity, ...opts } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchList(type, date, opts);
    } catch (e) {
      if (attempt >= retries || Date.now() + backoffMs > deadline) throw e;
      await sleep(backoffMs);
    }
  }
}

/** A day's departures and arrivals (both lists must succeed). */
export async function fetchXspDay(date, opts = {}) {
  // Wait for both (no stray retries left running), then fail if either did.
  const [dep, arr] = await Promise.allSettled([fetchListRetrying("D", date, opts), fetchListRetrying("A", date, opts)]);
  if (dep.status === "rejected") throw dep.reason;
  if (arr.status === "rejected") throw arr.reason;
  return { dep: dep.value, arr: arr.value };
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Cron step: fetch yesterday, today and tomorrow in parallel (with retries), then
 * make at most ONE KV write: the snapshot, which holds the days and the fetch status
 * together. It's written only when its hash (days + which days failed) changes, or
 * as a heartbeat every `heartbeatMs`. A day that still fails keeps its last good
 * copy and is listed in `status.dates`, so the API serves it as stale.
 *
 * Snapshot: { updatedAt, changedAt, hash, days: { [date]: { dep, arr } },
 *             status: { ok: true } | { ok: false, dates, error, since } }
 */
export async function refreshSeletar(env, { now = Date.now(), heartbeatMs = 30 * 60e3, ttlS = 4 * 86400, ...opts } = {}) {
  const today = sgtToday(now);
  const dates = XSP_DAYS.map((n) => addDays(today, n));
  const deadline = opts.deadline ?? now + XSP_RUN_BUDGET_MS;
  const results = await Promise.all(dates.map(async (date) => {
    try { return { date, ...(await fetchXspDay(date, { ...opts, deadline })) }; }
    catch (e) { return { date, error: e.message || String(e) }; }
  }));

  const prev = await env.BOARD_KV.get(XSP_KEY, "json");
  const failed = results.filter((r) => r.error);
  const failedDates = failed.map((r) => r.date);

  const days = {};
  for (const r of results) {
    if (!r.error) days[r.date] = { dep: r.dep, arr: r.arr };
    else if (prev && prev.days && prev.days[r.date]) days[r.date] = prev.days[r.date]; // last good copy
  }
  const prevStatus = prev && prev.status;
  const sameFailure = prevStatus && prevStatus.ok === false && (prevStatus.dates || []).join(",") === failedDates.join(",");
  const status = failedDates.length
    ? { ok: false, dates: failedDates, error: failed[0].error, since: sameFailure ? prevStatus.since : Date.now() }
    : { ok: true };

  // The hash covers the flights and which days failed, not the error text or times,
  // so a run that sees the same thing as the last one writes nothing.
  const hash = await sha256(JSON.stringify({ days, failed: failedDates }));
  const t = Date.now();
  let written = false;
  if (!prev || prev.hash !== hash || t - (prev.updatedAt || 0) >= heartbeatMs) {
    await env.BOARD_KV.put(XSP_KEY, JSON.stringify({
      updatedAt: t,
      changedAt: prev && prev.hash === hash ? prev.changedAt || prev.updatedAt : t,
      hash,
      days,
      status,
    }), { expirationTtl: ttlS });
    written = true;
  }
  return { dates, failed: failedDates, written, errors: failed.map((r) => `${r.date}: ${r.error}`) };
}
