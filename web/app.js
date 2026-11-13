"use strict";

// ================================================================ config

const API = (() => {
  const c = (window.CHANGI_API || "").replace(/\/+$/, "");
  if (c) return c;
  if (["localhost", "127.0.0.1"].includes(location.hostname) && location.port !== "8787") return "http://localhost:8787";
  return "";
})();

const CHANGI = [1.3644, 103.9915];
const AUTO_REFRESH_MS = 2 * 60e3; // board data (and live marks) while the page is visible
const MIN_SPIN_MS = 600; // keep the refresh spinner visible long enough to register
const OLD_DATA_MS = 15 * 60e3; // mention the data's own time when it's older than this
const REFRESH_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const TRAFFIC_REFRESH_MS = 15e3; // tracker tab
const MAP_MOVE_DEBOUNCE_MS = 800; // wait for the map to settle before fetching a new area
const MAX_DIST_NM = 250; // ADS-B providers cap an area query at 250 nm
const CHANGI_ZOOM = 10; // default view on load
// Seletar (WSSL / XSP): Tracker only. Its aircraft come from the same traffic call as
// everything else (the 25 nm area around Changi already reaches it).
const SELETAR = [1.4168, 103.8678];
const SELETAR_ZOOM = 13;
const NEAR_SELETAR_NM = 5;
const JUMP_ZOOM = 7; // zoom used when jumping to a plane found by callsign
const TRAFFIC_MAX_AGE_MS = 3 * 60e3; // drop live marks if positions are older than this
const EARLIER_GRACE_MIN = 60; // today: hide finished flights older than this

// ICAO airline designator (callsign prefix) -> IATA code used on the board.
const ICAO_TO_IATA = {
  SIA: "SQ", SQC: "SQ", TGW: "TR", MAS: "MH", CAL: "CI", ANA: "NH", JAL: "JL", QFA: "QF",
  UAE: "EK", BAW: "BA", CPA: "CX", KLM: "KL", QTR: "QR", THA: "TG", GIA: "GA", CES: "MU",
  CSN: "CZ", CCA: "CA", CXA: "MF", CSC: "3U", CHH: "HU", AXM: "AK", JSA: "3K", AIC: "AI",
  IGO: "6E", ETD: "EY", AFR: "AF", DLH: "LH", SWR: "LX", THY: "TK", KAL: "KE", AAR: "OZ",
  EVA: "BR", VJC: "VJ", HVN: "VN", PAL: "PR", CEB: "5J", AIQ: "FD", MXD: "OD", BTK: "ID",
  LNI: "JT", ALK: "UL", BBC: "BG", UAL: "UA", FIN: "AY", ANZ: "NZ", VOZ: "VA", JST: "JQ",
  FDX: "FX", UPS: "5X", CLX: "CV", ETH: "ET", SVA: "SV", TTW: "IT", HKE: "UO", CRK: "HX",
  XAX: "D7", RBA: "BI", MMA: "8M", AMU: "NX", DKH: "HO", CQH: "9C", APJ: "MM", PIA: "PK",
  KQA: "KQ", ACA: "AC", AUA: "OS", SAS: "SK",
  FFM: "FY", // Firefly (Seletar)
};

// IATA codes whose callsign prefix is in the map above (used to rule out false matches).
const KNOWN_IATA = new Set(Object.values(ICAO_TO_IATA));
// IATA -> ICAO for building a callsign from a board flight (first entry wins: SQ -> SIA, not SQC).
const IATA_TO_ICAO = {};
for (const [icao, iata] of Object.entries(ICAO_TO_IATA)) if (iata && !IATA_TO_ICAO[iata]) IATA_TO_ICAO[iata] = icao;

/** "SQ322" -> "SIA322"; null when the airline's callsign prefix isn't known. */
function callsignFor(f) {
  const icao = f && f.al && IATA_TO_ICAO[f.al];
  if (!icao) return null;
  const num = f.fn.slice(f.al.length).replace(/^0+/, "");
  return /^\d{1,4}[A-Z]?$/.test(num) ? icao + num : null;
}

// ---------------------------------------------------------------- cargo (Tracker)
//
// Freighter detection, client-side, from what the ADS-B feed already gives us:
// type code (ac.t), callsign (ac.cs) and registration (ac.reg). Edit this list.
// When unsure, don't tag: a missed freighter is better than a passenger jet tagged
// as cargo. A cargo-airline callsign alone is never enough; the type must fit too.
const CARGO_RULES = {
  // Types that are always freighters: tagged on their own.
  // (B77L is not here: it's the code for both the 777F and the passenger 777-200LR.)
  alwaysFreighterTypes: ["B74F", "B77F", "A124", "AN12", "A333F"],
  // Types also flown with passengers: tagged only with a cargo callsign (below).
  withCargoCallsignTypes: ["B744", "B748", "B77L", "B763", "B762", "B752", "B738", "A332", "A306", "MD11"],
  // Cargo airlines: their callsign (any flight number) counts as cargo.
  cargoCallsigns: {
    SQC: "Singapore Airlines Cargo", CKK: "China Cargo", FDX: "FedEx", UPS: "UPS", DHL: "DHL",
    GTI: "Atlas Air", CLX: "Cargolux", KZE: "KZE", NCA: "Nippon Cargo", ABW: "AirBridgeCargo",
    BOX: "AeroLogic", PAC: "Polar", CKS: "Kalitta", TAY: "ASL/TNT",
  },
  // Mixed airlines: their callsign counts as cargo only under these conditions.
  mixedAirlines: {
    CPA: { regPrefix: "B-L", types: ["B744", "B748"] }, // Cathay Cargo 747 freighters
    ETH: { types: ["B763", "B744", "B748"] }, // Ethiopian Cargo (its passenger 737-800s are excluded)
    MAS: { flightNumber: /^8\d\d$/ }, // MASkargo MAS8xx
    QTR: { flightNumber: /^8\d\d$/ }, // Qatar Cargo QTR8xx
  },
};
const CARGO_ALWAYS = new Set(CARGO_RULES.alwaysFreighterTypes);
const CARGO_WITH_CALLSIGN = new Set(CARGO_RULES.withCargoCallsignTypes);

/** True only when the type (and, for mixed types, the callsign) says freighter. */
function isFreighter(ac) {
  const type = String((ac && ac.t) || "").trim().toUpperCase();
  if (!type) return false;
  if (CARGO_ALWAYS.has(type)) return true;
  if (!CARGO_WITH_CALLSIGN.has(type)) return false;
  const m = String(ac.cs || "").trim().toUpperCase().match(/^([A-Z]{3})0*(\d{1,4}[A-Z]?)$/);
  if (!m) return false;
  const [, prefix, num] = m;
  if (Object.prototype.hasOwnProperty.call(CARGO_RULES.cargoCallsigns, prefix)) return true;
  const rule = CARGO_RULES.mixedAirlines[prefix];
  if (!rule) return false;
  if (rule.types && !rule.types.includes(type)) return false;
  if (rule.regPrefix && !String(ac.reg || "").trim().toUpperCase().startsWith(rule.regPrefix)) return false;
  if (rule.flightNumber && !rule.flightNumber.test(num)) return false;
  return true;
}

// ================================================================ utils

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem("cb:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("cb:" + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/** yyyy-MM-dd in Singapore (UTC+8, no DST). */
function sgtDate(offsetDays = 0, now = Date.now()) {
  return new Date(now + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
}
/** Minutes since SGT midnight for a "yyyy-MM-dd HH:mm" or ("HH:mm", date). */
function sgtMinutes(date, hhmm) {
  if (!date || !hhmm) return null;
  const t = Date.parse(`${date}T${hhmm}:00+08:00`);
  return Number.isFinite(t) ? t / 60e3 : null;
}
const fmtSGT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDay = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

/** `fresh` skips the browser's HTTP cache (used by the refresh button). */
async function getJSON(path, { fresh = false, signal } = {}) {
  const res = await fetch(API + path, { headers: { Accept: "application/json" }, cache: fresh ? "no-cache" : "default", signal });
  if (res.status === 401 && !location.search.includes("relock")) {
    // Gate locked (no/expired cookie), or a stale copy still calling the old
    // cross-origin API: bounce through the lock screen. With a valid cookie
    // this reload pulls the current page + config and self-heals. The relock
    // param stops a loop if the copy is still stale; then show the error.
    location.assign("/?relock=1");
    return new Promise(() => {}); // navigation takes over; never render an error
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ================================================================ status

function statusClass(f) {
  const s = `${f.raw || ""} ${f.status || ""}`.toLowerCase();
  if (/cancel|delay|re-?timed|divert/.test(s)) return "bad";
  if (/depart|landed|arrived/.test(s)) return "done";
  if (/board|gate open|gate clos|last call|new gate|go to gate|ask airline/.test(s)) return "warn";
  return "ok";
}
const isFinished = (f) => /depart|landed|arrived|cancel/i.test(`${f.raw} ${f.status}`);

/** Shorter status text that always keeps the time/gate: "Gate Info at 15:05" -> "Gate info 15:05". */
function statusLabel(f) {
  const s = f.status || "Scheduled";
  return s
    .replace(/^Gate Info at\s+/i, "Gate info ")
    .replace(/^New Gate\b/i, "New gate");
}

// ---------------------------------------------------------------- delays

const DELAY_TAG_MIN = 15; // show a tag when 15+ minutes late or early

/** Minutes between the actual (else estimated) time and the schedule; null when unknown or cancelled. */
function delayMinutes(f) {
  if (/cancel/i.test(`${f.raw || ""} ${f.status || ""}`)) return null;
  const ts = f.ats || f.ets;
  if (!ts || !f.d || !f.st) return null;
  const actual = Date.parse(`${ts.trim().replace(" ", "T").slice(0, 16)}:00+08:00`);
  const sched = Date.parse(`${f.d}T${f.st}:00+08:00`);
  if (!Number.isFinite(actual) || !Number.isFinite(sched)) return null;
  return Math.round((actual - sched) / 60e3);
}

const EARLY_ARRIVAL_WINDOW_MIN = 180; // arrivals: show "Early" only when due within 3 hours

function delayTagHTML(f, dir) {
  const m = delayMinutes(f);
  if (m === null || Math.abs(m) < DELAY_TAG_MIN) return "";
  // "Early" only helps before landing (e.g. leave sooner for a pickup); once landed,
  // the pill already shows the landing time. Delays always show.
  if (m < 0 && /landed|arrived/i.test(`${f.raw || ""} ${f.status || ""}`)) return "";
  // Arrivals: "Early" is useful for a pickup when the flight is due soon, not hours ahead.
  if (m < 0 && dir === "arr") {
    const due = flightTimeMin(f);
    if (due === null || due - Date.now() / 60e3 > EARLY_ARRIVAL_WINDOW_MIN) return "";
  }
  const basis = f.ats ? "actual" : "estimated";
  return m > 0
    ? `<span class="delay-tag late" title="${basis} time is ${m} min later than scheduled">Delayed</span>` // minutes: in the detail
    : `<span class="delay-tag early" title="${basis} time is ${-m} min earlier than scheduled">Early</span>`; // minutes: in the detail
}

/**
 * Expanded detail line, shown exactly when the row has a "Delayed" or "Early" tag:
 * "Delayed 125 min, new time 14:50 vs scheduled 12:45" or
 * "Early 26 min, new time 07:34 vs scheduled 08:00". Empty otherwise.
 */
function delayDetailHTML(f, dir) {
  if (!delayTagHTML(f, dir)) return ""; // same rules as the row tag
  const m = delayMinutes(f);
  const late = m > 0;
  const ts = (f.ats || f.ets).trim();
  const d = ts.slice(0, 10);
  const day = d && d !== f.d ? ` <small>${esc(fmtDay.format(new Date(d + "T00:00:00Z")))}</small>` : "";
  return `<div class="kv kv-wide"><dt>${late ? "Delay" : "Early"}</dt><dd class="delay-detail${late ? "" : " early"}">${late ? "Delayed" : "Early"} ${Math.abs(m)} min, new time ${esc(ts.slice(11, 16))}${day} vs scheduled ${esc(f.st)}</dd></div>`;
}

/** The time a row shows (estimated when Changi has one, else scheduled) and its sort key. */
const shownTime = (f) => f.et || f.st;
const effectiveTs = (f) => f.ets || `${f.d || ""} ${f.st || ""}`;

// Terminals: "1"-"4", or null when the feed hasn't assigned one yet.
const termLabel = (t) => (t ? `T${t}` : "TBC");
const termClass = (t) => (t ? `t${t}` : "tbc");
const flightKey = (f) => `${f.fn}|${f.st}`;

// ================================================================ favourites
//
// Saved flights live only in this browser (localStorage), never on the server.
// Each entry is one flight on one day in one direction: { dir, fn, d, st }.

const FAV_KEY = "flightlah_favs";
const FAV_LIMIT = 5;
const FAV_KEEP_DAYS = 2; // drop an entry 2 days after its date
const STAR_SVG = (filled) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.85 5.98 6.55.79-4.83 4.5 1.27 6.48L12 17.33l-5.84 3.22 1.27-6.48-4.83-4.5 6.55-.79z" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

function readFavs() {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return Array.isArray(v)
      ? v.filter((x) => x && typeof x.fn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.d) && (x.dir === "dep" || x.dir === "arr"))
      : [];
  } catch { return []; }
}
function writeFavs(list) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch { /* private mode etc.: keep in memory */ }
}
/** Remove entries whose date is FAV_KEEP_DAYS or more days ago (SGT). */
function pruneFavs(list) {
  const cutoff = sgtDate(-FAV_KEEP_DAYS);
  const kept = list.filter((x) => x.d > cutoff);
  if (kept.length !== list.length) writeFavs(kept);
  return kept;
}
let favs = [];

const favId = (dir, f) => `${dir}|${f.fn}|${f.d}`;
const isFav = (dir, f) => favs.some((x) => x.dir === dir && x.fn === f.fn && x.d === f.d);

/** Star or unstar a flight. Refuses a 6th with a message rather than dropping one. */
function toggleFav(dir, f) {
  favs = pruneFavs(favs);
  if (isFav(dir, f)) {
    favs = favs.filter((x) => !(x.dir === dir && x.fn === f.fn && x.d === f.d));
  } else if (favs.length >= FAV_LIMIT) {
    toast("You can save up to 5 flights. Remove one to add another.");
    return;
  } else {
    favs.push({ dir, fn: f.fn, d: f.d, st: f.st });
  }
  writeFavs(favs);
  renderSavedChip();
  renderBoard();
}

/** A small, self-dismissing message at the bottom of the screen. */
let toastTimer;
function toast(text) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}

/** The "Saved N" pill next to All / T1-T4 (added here so index.html stays unchanged). */
function renderSavedChip() {
  const chip = $('[data-term="saved"]');
  if (!chip) return;
  chip.innerHTML = `${STAR_SVG(state.term === "saved" || favs.length > 0)}<span>Saved</span>${favs.length ? `<span class="chip-count">${favs.length}</span>` : ""}`;
  chip.setAttribute("aria-label", `Saved flights${favs.length ? `, ${favs.length}` : ""}`);
}

// ================================================================ state

const state = {
  view: location.hash === "#tracker" ? "tracker" : "board",
  dir: store.get("dir", "dep"),
  term: store.get("term", "all"),
  wing: "all", // T1-T3 only: "all" or a GATE_SIDES side name ("West", "North", ...)
  day: 0,
  q: "",
  open: new Set(),
  showEarlier: false,
  boards: new Map(), // date -> payload
  fetchedAt: new Map(), // date -> when the page last fetched that board (ms)
  loading: false,
  errors: new Map(), // boardId -> last load error
  airport: store.get("airport", "sin") === "xsp" ? "xsp" : "sin", // Board tab: Changi or Seletar
};

/**
 * Key for a loaded board: Changi boards keep the plain date (the Tracker and live
 * marks read today's Changi board by date); Seletar's are "xsp:<date>".
 */
const boardId = (date, airport = state.airport) => (airport === "xsp" ? `xsp:${date}` : date);
const boardIdOf = (data) => boardId(data.date, data.airport === "XSP" ? "xsp" : "sin");
const isXsp = (f) => Boolean(f && f.apt === "XSP");

// ================================================================ board

/** Load one day's board. `airport` is "sin" (Changi, the default) or "xsp" (Seletar). */
async function loadBoard(date, { quiet = false, fresh = false, airport = "sin", animate = false } = {}) {
  const today = sgtDate(0);
  const id = boardId(date, airport);
  const path = airport === "xsp"
    ? `/api/board?airport=xsp&date=${date}`
    : date === today ? "/api/board" : `/api/board?date=${date}`;
  if (!quiet) { state.loading = true; renderBoard(); }
  try {
    const data = await getJSON(path, { fresh });
    state.boards.set(id, data);
    state.fetchedAt.set(id, Date.now());
    state.errors.delete(id);
  } catch (e) {
    state.errors.set(id, e.message);
  } finally {
    state.loading = false;
  }
  // Re-render in place: filters, open rows and "earlier flights" live in `state`;
  // keep the scroll position in case the list height changed.
  const y = window.scrollY;
  renderWithFlips(id, animate);
  if (quiet && window.scrollY !== y) window.scrollTo(0, y);
  if (date === today) onTodayBoard();
  if (state.pendingShare && date === currentDate() && airport === state.airport) resolveShareLink();
}

// ---------------------------------------------------------------- split-flap

// On an automatic refresh, rows that were on screen and whose shown time or status
// changed get a short split-flap flip (time digits, status pill) and a fading
// highlight. The board is re-rendered from scratch each time, so this works by
// taking a snapshot of the visible rows just before the render and comparing just
// after. Tiles exist only during the animation; the time cell gets its plain text
// back afterwards, so its font and colour are exactly as before.
const FLIP_MAX_ROWS = 8; // animated rows per refresh; the rest just update
const FLIP_DIGIT_MS = 600; // one digit: top folds down (300) + new bottom drops in (300)
const FLIP_STAGGER_MS = 150;
const PILL_FLIP_MS = 400;
const ROW_HIGHLIGHT_MS = 1500;

const rowId = (el) => `${el.dataset.dir}|${el.dataset.key}`;
const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; };

/** What the visible rows show right now, or null when there's nothing to compare against. */
function snapshotRows(id) {
  const box = $("#board");
  if (state.view !== "board" || state.term === "standby" || box.dataset.board !== id) return null;
  const rows = new Map();
  for (const el of $$(".flight", box)) {
    if (!onScreen(el)) continue;
    const t = el.querySelector(".f-time"), p = el.querySelector(".pill");
    if (!t || !p) continue;
    rows.set(rowId(el), {
      time: t.dataset.final || t.textContent,
      status: p.dataset.final || p.textContent,
      pillClass: p.dataset.finalClass || p.className,
    });
  }
  return { id, rows };
}

/** Render the board; when `animate`, flip the rows whose time or status changed. */
function renderWithFlips(id, animate) {
  const before = animate ? snapshotRows(id) : null;
  renderBoard();
  if (before) flipChangedRows(before);
}

function flipChangedRows(before) {
  const box = $("#board");
  if (box.dataset.board !== before.id || state.term === "standby") return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let n = 0;
  for (const el of $$(".flight", box)) {
    if (n >= FLIP_MAX_ROWS) break;
    const prev = before.rows.get(rowId(el));
    if (!prev || !onScreen(el)) continue; // only rows that were, and still are, on screen
    const t = el.querySelector(".f-time"), p = el.querySelector(".pill");
    const timeChanged = prev.time !== t.textContent;
    const statusChanged = prev.status !== p.textContent;
    if (!timeChanged && !statusChanged) continue;
    n++;
    el.classList.add("just-changed");
    setTimeout(() => el.classList.remove("just-changed"), ROW_HIGHLIGHT_MS + 100);
    if (reduce) continue; // reduced motion: highlight only, no flip
    if (timeChanged) flipTime(t, prev.time);
    if (statusChanged) flipPill(p, prev);
  }
}

/** Flip only the changed digits of a time cell, then put its plain text back. */
function flipTime(t, oldText) {
  const now = t.textContent;
  if (oldText.length !== now.length) return; // different shape: just update
  let k = 0, html = "";
  for (let i = 0; i < now.length; i++) {
    const a = oldText[i], c = now[i];
    if (a === c) { html += esc(c); continue; }
    // The hidden copy keeps the cell exactly as wide and tall as plain text.
    html += `<span class="flap" style="--flap-delay:${(k++ * FLIP_STAGGER_MS) / 1000}s"><span class="flap-size">${esc(c)}</span>`
      + `<span class="flap-p flap-top">${esc(c)}</span><span class="flap-p flap-bottom">${esc(a)}</span>`
      + `<span class="flap-p flap-fold-top">${esc(a)}</span><span class="flap-p flap-fold-bottom">${esc(c)}</span></span>`;
  }
  if (!k) return;
  t.dataset.final = now;
  t.classList.add("flipping");
  t.innerHTML = html;
  setTimeout(() => {
    if (!t.isConnected) return; // re-rendered meanwhile: nothing to clean up
    t.textContent = now;
    t.classList.remove("flipping");
    delete t.dataset.final;
  }, (k - 1) * FLIP_STAGGER_MS + FLIP_DIGIT_MS + 50);
}

/** Status pill: the old label folds away, the new one folds in (~0.4 s). */
function flipPill(p, prev) {
  const nowText = p.textContent, nowClass = p.className;
  p.dataset.final = nowText;
  p.dataset.finalClass = nowClass;
  p.textContent = prev.status;
  p.className = `${prev.pillClass} pill-flip-out`;
  setTimeout(() => {
    if (!p.isConnected) return;
    p.textContent = nowText;
    p.className = `${nowClass} pill-flip-in`;
    setTimeout(() => {
      if (!p.isConnected) return;
      p.className = nowClass;
      delete p.dataset.final;
      delete p.dataset.finalClass;
    }, PILL_FLIP_MS / 2 + 30);
  }, PILL_FLIP_MS / 2);
}

// Sample aircraft for flightlahDebug.cargoCheck(): the first two must be cargo, the rest not.
const CARGO_SAMPLES = [
  { label: "747-400F, Singapore Airlines Cargo", cs: "SQC7398", t: "B744", reg: "9V-SFN" },
  { label: "777F, FedEx", cs: "FDX5021", t: "B77L", reg: "N851FD" },
  { label: "A350 passenger, Singapore Airlines", cs: "SIA322", t: "A359", reg: "9V-SMA" },
  { label: "737 MAX passenger type with a cargo-looking callsign", cs: "SQC9101", t: "B38M", reg: "9V-MBA" },
  { label: "777-200LR passenger (same B77L code as the 777F)", cs: "QTR920", t: "B77L", reg: "A7-BBC" },
];

/**
 * Debug helper (console): simulate an auto-refresh in which one visible row's time
 * and/or status changed, through the same path as a real refresh. Changes only this
 * page's in-memory copy of the board; the next real refresh replaces it.
 *   flightlahDebug.simulateChange()                         // +7 min on the first visible row
 *   flightlahDebug.simulateChange({ minutes: 125, status: "Delayed" })
 *   flightlahDebug.simulateChange({ key: "SQ608|00:10", dir: "dep", status: "Boarding" })
 */
window.flightlahDebug = {
  /**
   * Cargo detector check on sample aircraft (or your own list):
   *   flightlahDebug.cargoCheck()  ->  [{ label, cs, t, cargo }]
   */
  cargoCheck(samples = CARGO_SAMPLES) {
    return samples.map((s) => ({ ...s, cargo: isFreighter(s) }));
  },
  simulateChange({ key, dir, minutes = 7, status } = {}) {
    const id = boardId(currentDate());
    const data = state.boards.get(id);
    const el = key
      ? $$("#board .flight").find((x) => x.dataset.key === key && (!dir || x.dataset.dir === dir))
      : $$("#board .flight").find(onScreen);
    if (!data || !el) return null;
    const copy = JSON.parse(JSON.stringify(data));
    const f = (copy[el.dataset.dir] || []).find((x) => flightKey(x) === el.dataset.key);
    if (!f) return null;
    if (minutes) {
      const [h, m] = shownTime(f).split(":").map(Number);
      const tot = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
      f.et = `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`;
      f.ets = `${f.d} ${f.et}`;
    }
    if (status) f.status = f.raw = status;
    state.boards.set(id, copy);
    const y = window.scrollY;
    renderWithFlips(id, true);
    if (window.scrollY !== y) window.scrollTo(0, y);
    return { dir: el.dataset.dir, key: el.dataset.key, time: shownTime(f), status: statusLabel(f) };
  },
};

function currentDate() { return sgtDate(state.day); }

function filteredFlights(data, dir = state.dir) {
  // Sort by the time each row shows, so retimed flights sit where their time says.
  const list = [...((data && data[dir]) || [])]
    .sort((a, b) => effectiveTs(a).localeCompare(effectiveTs(b)) || (a.fn || "").localeCompare(b.fn || ""));
  const q = state.q.trim().toLowerCase();
  return list.filter((f) => {
    if (state.term === "saved") { if (!isFav(dir, f)) return false; }
    else if (state.term !== "all" && f.t !== state.term) return false;
    // Wing sub-filter: by the gate's letter; flights without a gate only show under "All".
    if (state.wing !== "all" && state.term !== "saved" && gateWing(f) !== state.wing) return false;
    if (!q) return true;
    const compactQ = q.replace(/\s+/g, "");
    return (
      (f.city || "").toLowerCase().includes(q) ||
      (f.ap || "").toLowerCase() === q ||
      (f.an || "").toLowerCase().includes(q) ||
      (f.fn || "").toLowerCase().includes(compactQ)
    );
  });
}

/** "3" -> "Door 3", "1-6 (Basement 1)" -> "Doors 1-6 (Basement 1)". */
const doorLabel = (v) => `${/^\s*\d+\s*[-–,]/.test(v) ? "Doors" : "Door"} ${v}`;

/** Departures only: a published gate that differs from the previous one (L/R ignored by the Worker). */
const gateChanged = (f) => Boolean(f.gate && f.gate_was);

// Ground handler per airline (IATA code), one line each so it's easy to edit.
const GHA = {
  // Source: Changi Airport official airline information page, 8 Nov 2026.
  // APS = SATS Asia-Pacific Star (SATS' LCC handling brand).
  // Contracts change hands, so this may go stale. Re-check the Changi page.
  "2W": "SATS",
  "3U": "SATS",
  "5J": "dnata",
  "6E": "dnata",
  "7C": "dnata",
  "8B": "APS",
  "8G": "dnata",
  "8M": "dnata",
  "9C": "GTRSG",
  "9G": "GTRSG",
  "AC": "SATS",
  "AF": "dnata",
  "AI": "SATS",
  "AK": "GTRSG",
  "AQ": "GTRSG",
  "AY": "dnata",
  "BA": "SATS",
  "BG": "SATS",
  "BI": "dnata",
  "BR": "SATS",
  "BS": "SATS",
  "CA": "SATS",
  "CI": "dnata",
  "CX": "GTRSG",
  "CZ": "SATS",
  "DV": "SATS",
  "E9": "SATS",
  "EK": "dnata",
  "ET": "SATS",
  "EY": "dnata",
  "FD": "GTRSG",
  "FJ": "SATS",
  "FM": "SATS",
  "FY": "APS",
  "GA": "dnata",
  "GF": "SATS",
  "GJ": "GTRSG",
  "GS": "dnata",
  "HO": "dnata",
  "HU": "GTRSG",
  "ID": "APS",
  "IP": "GTRSG",
  "IX": "SATS",
  "JL": "SATS",
  "JQ": "GTRSG",
  "JX": "SATS",
  "KB": "dnata",
  "KE": "GTRSG",
  "KL": "dnata",
  "KR": "GTRSG",
  "LH": "SATS",
  "LX": "SATS",
  "MF": "SATS",
  "MH": "SATS",
  "MM": "APS",
  "MU": "SATS",
  "MY": "dnata",
  "NH": "SATS",
  "NX": "GTRSG",
  "NZ": "SATS",
  "OD": "APS",
  "OM": "GTRSG",
  "OQ": "SATS",
  "OZ": "SATS",
  "PG": "dnata",
  "PN": "GTRSG",
  "PR": "SATS",
  "PX": "SATS",
  "QF": "SATS",
  "QG": "dnata",
  "QR": "SATS",
  "SB": "dnata",
  "SC": "SATS",
  "SL": "APS",
  "SQ": "SATS",
  "SV": "SATS",
  "TG": "SATS",
  "TK": "SATS",
  "TR": "APS",
  "TW": "APS",
  "UA": "SATS",
  "UB": "dnata",
  "UL": "dnata",
  "VJ": "GTRSG",
  "VN": "SATS",
  "WY": "dnata",
  "ZG": "SATS",
  "ZH": "SATS",
};

/** Ground handler for a flight's airline, or null when the airline isn't in GHA. */
const groundHandler = (f) => (f && f.al && Object.prototype.hasOwnProperty.call(GHA, f.al) ? GHA[f.al] : null);
/** Longer name for the expanded detail (rows just show the short name). */
const GHA_DETAIL_NAMES = { APS: "APS (SATS budget arm)" };

// Terminal side for an arrival gate, from the gate's first letter (static lookup;
// T4's G/H gates have no side). Letters are unique across T1-T3.
const GATE_SIDES = {
  C: ["1", "West"], D: ["1", "East"],
  E: ["2", "North"], F: ["2", "South"],
  A: ["3", "South"], B: ["3", "North"],
};

/** "F56L" -> "F56": the public gate number without the hold-room side. */
const plainGate = (g) => String(g).trim().toUpperCase().replace(/(\d)[LR]$/, "$1");

/** The wing ("West", "North", ...) a flight's gate is in, or null (no gate, or T4). */
function gateWing(f) {
  if (!f || !f.gate) return null;
  const side = GATE_SIDES[plainGate(f.gate)[0]];
  return side ? side[1] : null;
}

/**
 * Gate text for both directions: "T1 West · Gate C20", or "T4 · Gate G9" when the
 * letter has no wing. Departures keep Changi's gate as shown (hold-room L/R included).
 */
function gateLineHTML(f, dep) {
  const g = dep ? String(f.gate).trim().toUpperCase() : plainGate(f.gate);
  const side = GATE_SIDES[plainGate(f.gate)[0]];
  const where = side
    ? `<span class="t${side[0]}">T${side[0]} ${side[1]}</span> · `
    : f.t ? `<span class="${termClass(f.t)}">T${esc(f.t)}</span> · ` : "";
  return `${where}Gate ${esc(g)}`;
}

// ---------------------------------------------------------------- seats (estimate)

// Typical seats for common airline + aircraft combinations at Changi (IATA airline
// code, ICAO type code as Changi lists it). An estimate of the cabin, not a passenger
// count: airlines don't publish how many people are on board. Edit one line each.
const SEATS = {
  "SQ A359": 253, "SQ B77W": 264, "SQ B78X": 337, "SQ A388": 471, "SQ B38M": 154,
  "TR A20N": 186, "TR A21N": 236, "TR A320": 180, "TR B788": 335, "TR B789": 375, "TR E290": 112,
  "AK A320": 180, "AK A20N": 186, "AK A21N": 236, "FD A320": 180, "QZ A320": 180,
  "6E A20N": 186, "6E A21N": 222,
  "MH B738": 160, "MH B38M": 166, "OD B738": 162, "GA B738": 162,
  "8B A320": 180, "ID A320": 180, "VJ A321": 230, "VN A321": 184,
  "EK B77W": 354, "TK A359": 329, "QR A359": 283, "QR A35K": 327, "CX A359": 280,
  "QF A388": 485, "QF B789": 236,
};

// ---------------------------------------------------------------- aircraft names

// ICAO type code -> the family name people know. Display only: the raw code stays on
// the flight (the seat estimate uses it). A code that isn't here is shown as it is.
const AC_NAMES = {
  // Airbus
  A318: "A318", A319: "A319", A320: "A320", A321: "A321",
  A19N: "A319neo", A20N: "A320neo", A21N: "A321neo",
  BCS1: "A220", BCS3: "A220",
  A332: "A330", A333: "A330", A338: "A330", A339: "A330",
  A342: "A340", A343: "A340", A345: "A340", A346: "A340",
  A359: "A350", A35K: "A350",
  A388: "A380",
  // Boeing
  B733: "737", B734: "737", B735: "737", B736: "737", B737: "737", B738: "737", B739: "737",
  B37M: "737", B38M: "737", B39M: "737", B3XM: "737",
  B742: "747", B744: "747", B748: "747",
  B752: "757", B753: "757",
  B762: "767", B763: "767", B764: "767",
  B772: "777", B773: "777", B77L: "777", B77W: "777", B778: "777", B779: "777",
  B788: "787", B789: "787", B78X: "787",
  // Embraer, ATR, others
  E170: "Embraer 170", E175: "Embraer 175", E190: "Embraer 190", E195: "Embraer 195",
  E290: "Embraer 190-E2", E295: "Embraer 195-E2",
  AT43: "ATR 42", AT45: "ATR 42", AT46: "ATR 42",
  AT72: "ATR 72", AT75: "ATR 72", AT76: "ATR 72",
  DH8D: "Dash 8-400", CRJ9: "CRJ900",
};

/** "B788" -> "787"; unknown codes come back unchanged, empty stays empty. */
function acName(code) {
  const c = String(code || "").trim();
  return AC_NAMES[c.toUpperCase()] || c;
}

/** "~253 seats (est.)" for a known airline + aircraft type, else null. */
function seatEstimate(f) {
  const n = f && f.al && f.ac ? SEATS[`${f.al} ${String(f.ac).toUpperCase()}`] : undefined;
  return n ? `~${n} seats (est.)` : null;
}

function gettingThereHTML(f, dep) {
  const item = (k, v) => (v ? `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>` : "");
  const items = dep
    ? item("Drop-off", f.drop_door && doorLabel(f.drop_door))
    : item("Pick-up", f.pick_door && doorLabel(f.pick_door)) + item("Nearest car park", f.carpark);
  if (!items) return "";
  return `<section class="f-detail f-getting" aria-label="Getting there">
    <h3 class="f-eyebrow">Getting there${f.t ? ` · <span class="${termClass(f.t)}">T${esc(f.t)}</span>` : ""}</h3>
    ${items}
  </section>`;
}

/** Seletar detail: what its feed has (no terminal, gate, check-in row or aircraft type). */
function xspDetailHTML(f, dir) {
  const kv = (k, v) => (v ? `<div class="kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>` : "");
  const dep = dir === "dep";
  const saved = isFav(dir, f);
  const d = f.ets && f.ets.slice(0, 10);
  const updated = f.et ? `${esc(f.et)}${d && d !== f.d ? ` <small>${esc(fmtDay.format(new Date(d + "T00:00:00Z")))}</small>` : ""}` : "—";
  return `<dl class="f-detail">
    ${kv(dep ? "To" : "From", `${esc(f.city || f.ap)} <small>${esc(f.ap || "")}</small>`)}
    ${kv("Airline", esc(f.an || f.al))}
    ${kv("Airport", '<span class="xsp">Seletar (XSP)</span>')}
    ${dep ? kv("Door", esc(f.door) || "—") : kv("Belt", esc(f.belt) || "—")}
    ${kv("Scheduled", esc(f.st))}
    ${kv(dep ? "Departure (latest)" : "Arrival (latest)", updated)}
    ${delayDetailHTML(f, dir)}
    ${kv("Status", esc(f.status) || "No update yet")}
  </dl>
  <div class="f-actions">
    ${state.day === 0 ? `<button class="track-btn" type="button" data-track="${esc(flightKey(f))}">${trackLabel(isLive(f, dir))}</button>` : ""}
    <button class="save-btn${saved ? " saved" : ""}" type="button" data-fav aria-pressed="${saved}">${STAR_SVG(saved)}${saved ? "Saved" : "Save flight"}</button>
    <button class="save-btn share-btn" type="button" data-share>${SHARE_SVG}Share</button>
  </div>`;
}

function detailHTML(f, dir = state.dir) {
  if (isXsp(f)) return xspDetailHTML(f, dir);
  const kv = (k, v) => (v ? `<div class="kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>` : "");
  const time = (hm, ts) => {
    if (!hm) return "";
    const d = ts && ts.slice(0, 10);
    return d && d !== f.d ? `${esc(hm)} <small>${esc(fmtDay.format(new Date(d + "T00:00:00Z")))}</small>` : esc(hm);
  };
  const place = `${esc(f.city || f.ap)} <small>${esc([f.ap, f.cc].filter(Boolean).join(" · "))}</small>`;
  const dep = dir === "dep";
  const saved = isFav(dir, f);
  return `<dl class="f-detail">
    ${kv(dep ? "To" : "From", place)}
    ${kv("Airline", esc(f.an || f.al))}
    ${groundHandler(f) ? kv("Ground handler", `<span class="gha-detail">${esc(GHA_DETAIL_NAMES[groundHandler(f)] || groundHandler(f))}</span>`) : ""}
    ${dep ? kv("Gate", f.gate
      ? `${gateLineHTML(f, true)}${gateChanged(f) ? `<small class="gate-was">Gate changed, was ${esc(f.gate_was)}</small>` : ""}`
      : "—") : (f.gate ? kv("Gate", `${gateLineHTML(f, false)}${gateChanged(f) ? `<small class="gate-was">Gate changed, was ${esc(f.gate_was)}</small>` : ""}`) : "") + kv("Belt", f.belt ? `${esc(f.belt)}${f.belt_status ? ` <small>${esc(f.belt_status)}</small>` : ""}` : "—")}
    ${dep ? kv("Check-in row", esc(f.row) || "—") : ""}
    ${kv("Scheduled", time(f.st, `${f.d} ${f.st}`))}
    ${kv("Estimated", time(f.et, f.ets) || "—")}
    ${kv("Actual", time(f.at, f.ats) || "—")}
    ${delayDetailHTML(f, dir)}
    ${kv("Aircraft", esc(acName(f.ac)) || "—")}
    ${kv("Terminal", f.t ? `<span class="${termClass(f.t)}">T${esc(f.t)}</span>` : "Not assigned yet")}
    ${seatEstimate(f) ? `<div class="kv kv-seats"><dt>Seats</dt><dd>${esc(seatEstimate(f))}<small class="seat-note">Typical seat count for this aircraft — airlines don't publish the actual number of passengers on board.</small></dd></div>` : ""}
  </dl>
  ${gettingThereHTML(f, dep)}
  <div class="f-actions">
    ${state.day === 0 ? `<button class="track-btn" type="button" data-track="${esc(flightKey(f))}">${trackLabel(isLive(f, dir))}</button>` : ""}
    <button class="save-btn${saved ? " saved" : ""}" type="button" data-fav aria-pressed="${saved}">${STAR_SVG(saved)}${saved ? "Saved" : "Save flight"}</button>
    <button class="save-btn share-btn" type="button" data-share>${SHARE_SVG}Share</button>
  </div>`;
}

function rowHTML(f, dir = state.dir) {
  const key = flightKey(f);
  const open = state.open.has(key);
  const changed = Boolean(f.et && f.et !== f.st);
  const live = isLive(f, dir);
  const dep = dir === "dep";
  const saved = isFav(dir, f);
  // Flag the change on the row only while people may still be heading to the gate;
  // the detail keeps it after departure.
  const moved = gateChanged(f) && !isFinished(f);
  const note = moved ? `<span class="f-note">Gate changed, was ${esc(f.gate_was)}</span>` : "";
  // Second line, both directions: wing, gate and ground handler ("T1 West · Gate C20 · SATS"),
  // once Changi publishes the gate. No gate: the terminal column says it all.
  const gha = isXsp(f) ? null : groundHandler(f);
  // Seletar: no terminals; the second line is the door (departures) or belt (arrivals).
  const xspLine = isXsp(f) && (dep ? f.door : f.belt)
    ? `<span class="f-sub f-gate">${esc(dep ? f.door : `Belt ${f.belt}`)}</span>`
    : "";
  const side = isXsp(f) ? xspLine : f.gate
    ? `<span class="f-sub f-gate${moved ? " changed" : ""}"${moved ? ` title="Gate changed from ${esc(f.gate_was)}"` : ""}>${gateLineHTML(f, dep)}${gha ? ` · <span class="f-gha" title="Ground handler">${esc(gha)}</span>` : ""}</span>`
    : "";
  // The row is a focusable element acting as a button (Enter/Space open it), so the
  // star can be a real button inside it without opening the row.
  return `<div class="flight${open ? " open" : ""}${live ? " live" : ""}${saved ? " saved" : ""}" data-key="${esc(key)}" data-dir="${dir}">
    <div class="f-row" role="button" tabindex="0" aria-expanded="${open}">
      <span class="live-tag" title="On the map now"><span class="sr-only">Live on map. </span></span>
      <span class="f-time${changed ? " changed" : ""}" title="${changed ? `Scheduled ${esc(f.st)}, estimated ${esc(f.et)}` : "Scheduled"}">${esc(shownTime(f))}</span>
      <span class="f-flight"><span class="f-fn">${esc(f.fn)}</span></span>
      <span class="f-city">${esc(f.city || f.ap)}</span>
      <span class="f-where">${isXsp(f)
        ? '<span class="f-term xsp" title="Seletar Airport">XSP</span>'
        : `<span class="f-term ${termClass(f.t)}"${f.t ? "" : ' title="Terminal not assigned yet"'}>${termLabel(f.t)}</span>`}</span>
      <span class="f-status"><span class="pill ${statusClass(f)}" title="${esc(f.status)}">${esc(statusLabel(f))}</span>${delayTagHTML(f, dir)}</span>
      ${side}${note}
      <button class="fav-btn" type="button" data-fav aria-pressed="${saved}" aria-label="${saved ? "Remove" : "Save"} ${esc(f.fn)}${saved ? " from saved flights" : ""}" title="${saved ? "Saved" : "Save flight"}">${STAR_SVG(saved)}</button>
    </div>
    ${open ? detailHTML(f, dir) : ""}
  </div>`;
}

// ---------------------------------------------------------------- live marks

const liveKey = (dir, f) => `${dir}|${flightKey(f)}`;
const trackLabel = (live) => (live ? "See it live →" : "Track on map");

/** Is this board flight's plane on the map right now? Only meaningful for today. */
function isLive(f, dir = state.dir) {
  return state.day === 0 && tracker.live.has(liveKey(dir, f));
}

/** Rebuild the set of board flights that have a plane in the latest positions. */
function computeLive() {
  const fresh = Date.now() - tracker.trafficAt < TRAFFIC_MAX_AGE_MS;
  const live = new Set();
  if (fresh && tracker.index) {
    for (const ac of tracker.traffic) {
      const f = matchFlight(ac.cs);
      if (f) live.add(liveKey(f.dir, f));
    }
  }
  tracker.live = live;
  updateLiveMarks();
}

/** Update live dots and track buttons in place, without re-rendering the board. */
function updateLiveMarks() {
  if (state.view !== "board") return;
  for (const el of $$(".flight")) {
    const live = state.day === 0 && tracker.live.has(`${el.dataset.dir || state.dir}|${el.dataset.key}`);
    el.classList.toggle("live", live);
    const btn = el.querySelector(".track-btn");
    if (btn) btn.textContent = trackLabel(live);
  }
}

/**
 * "Last updated" is when this page last fetched the board. The flight data's own
 * time (when the Worker last saw a change) is in the tooltip, and is spelled out
 * when it's older than a couple of cron cycles.
 */
function renderUpdated(data) {
  const el = $("#updated");
  if (!data) { el.textContent = ""; return; }
  if (data.offline) {
    // Served by the service worker from its last good copy (no network).
    const at = data.offlineAt ? fmtSGT.format(new Date(data.offlineAt)) : null;
    // The phone says it's offline -> "Offline"; otherwise the network was just too slow.
    const offline = navigator.onLine === false;
    el.title = offline
      ? "No connection: this is the last board flightlah saved on this device"
      : "The connection is slow: this is the last saved board, and it updates as soon as the new one arrives";
    el.innerHTML = `<span class="stale">${offline ? "Offline" : "Slow connection"}</span> · showing data from ${esc(at || "earlier")}`;
    return;
  }
  const err = state.errors.get(boardIdOf(data));
  const fetched = state.fetchedAt.get(boardIdOf(data)) || data.updatedAt;
  const t = fmtSGT.format(new Date(fetched));
  const dataTime = fmtSGT.format(new Date(data.updatedAt));
  const old = Date.now() - data.updatedAt > OLD_DATA_MS;
  const stale = data.stale || err;
  el.title = `Flight data last changed at ${dataTime} SGT`;
  // One line: when the page last updated, then the most useful second fact.
  const tail = stale
    ? `<span class="stale" title="${esc(data.error || err || "")}">data may be slightly old</span>`
    : old
      ? `data from ${esc(dataTime)}`
      : `auto-refreshes every ${AUTO_REFRESH_MS / 60e3} min`;
  el.innerHTML = `Updated ${esc(t)} SGT · ${tail}`;
}

/** Today's finished flights older than the grace period are tucked away. */
function isEarlier(f) {
  if (!isFinished(f)) return false;
  const ts = f.ats || f.ets;
  const m = ts ? sgtMinutes(ts.slice(0, 10), ts.slice(11, 16)) : sgtMinutes(f.d, f.st);
  return m !== null && m < Date.now() / 60e3 - EARLIER_GRACE_MIN;
}

// Wide screens (900px+): departures and arrivals side by side instead of the toggle.
const WIDE_MQ = window.matchMedia("(min-width: 900px)");
const isWide = () => WIDE_MQ.matches;
const DIRS = [["dep", "Departures"], ["arr", "Arrivals"]];

/** One board column (wide screens): heading, earlier-flights toggle, rows or an empty note. */
function columnHTML(dir, title, data) {
  let list = filteredFlights(data, dir);
  let hidden = 0;
  if (state.day === 0 && !state.q && !state.showEarlier) {
    const keep = list.filter((f) => !isEarlier(f));
    hidden = list.length - keep.length;
    list = keep;
  }
  const more = hidden ? `<button class="more" data-act="earlier">Show ${hidden} earlier flight${hidden === 1 ? "" : "s"}</button>` : "";
  const less = state.day === 0 && state.showEarlier && !state.q ? `<button class="more" data-act="later">Hide earlier flights</button>` : "";
  const body = list.length
    ? more + less + list.map((f) => rowHTML(f, dir)).join("")
    : more + `<p class="empty">${esc(noFlightsText())}</p>`;
  return `<section class="board-col" aria-label="${title}"><h2 class="col-head">${title}</h2>${body}</section>`;
}

/** Empty-list text for the board on screen. */
const noFlightsText = () => (state.q
  ? "No flights match your search."
  : state.airport === "xsp" ? "No Seletar flights on this day." : "No flights.");

function renderBoard() {
  const date = currentDate();
  const data = state.boards.get(boardId(date));
  const error = state.errors.get(boardId(date));
  const box = $("#board");
  box.setAttribute("aria-busy", String(state.loading));
  box.dataset.board = boardId(date); // which board the rows on screen came from (split-flap diff)
  renderUpdated(data);
  renderStandbyChip();
  if (state.term === "standby") { renderStandby(box); return; }

  if (!data) {
    // No network (fetch itself failed) and nothing saved on this device for this day.
    const noNet = navigator.onLine === false || /failed to fetch|networkerror|load failed/i.test(error || "");
    box.innerHTML = state.loading
      ? `<p class="empty">Loading flights…</p>`
      : noNet
        ? `<p class="empty error">No connection, and this day isn't saved on this device yet. It will load when you're back online.</p>`
        : `<p class="empty error">Couldn't load ${state.airport === "xsp" ? "Seletar " : ""}flights${error ? `: ${esc(error)}` : ""}.</p>`;
    return;
  }

  favs = pruneFavs(favs);
  renderSavedChip();
  if (state.term === "saved") { renderSaved(data, box); return; }
  if (isWide()) {
    box.innerHTML = `<div class="cols">${DIRS.map(([dir, title]) => columnHTML(dir, title, data)).join("")}</div>`;
    return;
  }

  let list = filteredFlights(data);
  let hidden = 0;
  if (state.day === 0 && !state.q && !state.showEarlier) {
    const keep = list.filter((f) => !isEarlier(f));
    hidden = list.length - keep.length;
    list = keep;
  }

  const more = hidden ? `<button class="more" data-act="earlier">Show ${hidden} earlier flight${hidden === 1 ? "" : "s"}</button>` : "";
  const less = state.day === 0 && state.showEarlier && !state.q ? `<button class="more" data-act="later">Hide earlier flights</button>` : "";
  box.innerHTML = list.length
    ? more + less + list.map((f) => rowHTML(f)).join("")
    : more + `<p class="empty">${esc(noFlightsText())}</p>`;
}

/** Saved view: the selected day's starred flights, departures and arrivals together. */
function renderSaved(data, box) {
  const sections = [["dep", "Departures"], ["arr", "Arrivals"]]
    .map(([dir, title]) => ({ dir, title, list: filteredFlights(data, dir) }))
    .filter((s) => s.list.length);
  if (sections.length && isWide()) {
    box.innerHTML = `<div class="cols">${DIRS.map(([dir, title]) => {
      const s = sections.find((x) => x.dir === dir);
      const body = s ? s.list.map((f) => rowHTML(f, dir)).join("") : `<p class="empty">No saved ${title.toLowerCase()} on this day.</p>`;
      return `<section class="board-col" aria-label="${title}"><h2 class="col-head">${title}</h2>${body}</section>`;
    }).join("")}</div>`;
    return;
  }
  if (sections.length) {
    box.innerHTML = sections.map((s) =>
      `<h2 class="saved-head">${s.title}</h2>${s.list.map((f) => rowHTML(f, s.dir)).join("")}`).join("");
    return;
  }
  let msg;
  if (state.q) msg = "No saved flights match your search.";
  else if (!favs.length) msg = "No saved flights yet. Tap the star on a flight.";
  else msg = `No saved flights on this day. You have ${favs.length} saved on other days.`;
  box.innerHTML = `<p class="empty">${msg}</p>`;
}

/** Standby view: aircraft broadcasting an emergency squawk (not tied to the board's day). */
function renderStandby(box) {
  const list = [...tracker.standby.values()]
    .sort((a, b) => haversineKm(CHANGI, [a.lat, a.lon]) - haversineKm(CHANGI, [b.lat, b.lon]));
  const intro = `<p class="sb-intro">Aircraft in the latest live positions (around Changi, or the area the
    Tracker map shows) that have broadcast an emergency transponder code on two position updates in a row.
    A squawk is a broadcast, not a confirmed incident: it can be set by mistake or during a test,
    and most end with a normal landing.</p>`;
  if (!list.length) {
    box.innerHTML = intro + `<p class="empty">No aircraft are broadcasting an emergency code right now.</p>`;
    return;
  }
  box.innerHTML = intro + list.map((ac) => {
    const [, meaning] = EMERGENCY_SQUAWKS[ac.sq];
    const alt = ac.alt != null ? `${Math.round(ac.alt).toLocaleString("en-US")} ft` : "—";
    const spd = ac.gs != null ? `${Math.round(ac.gs)} kt` : "—";
    const km = haversineKm(CHANGI, [ac.lat, ac.lon]);
    const pos = `${ac.lat.toFixed(3)}, ${ac.lon.toFixed(3)} <small>${km.toFixed(0)} km from Changi</small>`;
    return `<article class="sb-item" aria-label="${esc(ac.cs || "Unknown flight")}, possible emergency">
      <div class="sb-head">
        <span class="sb-cs${ac.cs ? "" : " c-unknown"}">${esc(ac.cs || "Unknown flight")}</span>
        <span class="sb-type">${esc([acName(ac.t), ac.reg].filter(Boolean).join(" · ") || "Unknown type")}</span>
        <span class="sb-sq">Squawk ${esc(ac.sq)}</span>
      </div>
      <p class="sb-meaning">Possible emergency: ${esc(meaning)}</p>
      <dl class="sb-stats">
        <div class="kv"><dt>Altitude</dt><dd>${esc(alt)}</dd></div>
        <div class="kv"><dt>Speed</dt><dd>${esc(spd)}</dd></div>
        <div class="kv"><dt>Position</dt><dd>${pos}</dd></div>
      </dl>
      <button class="track-btn" type="button" data-standby-hex="${esc(ac.hex)}">Show on map</button>
    </article>`;
  }).join("");
}

/** Standby -> Tracker: centre the map on that aircraft and open its card. */
function showStandbyOnMap(hex) {
  const ac = tracker.standby.get(hex);
  if (!ac) return;
  tracker.focus = null;
  show("tracker");
  const go = () => {
    if (!tracker.map) { setTimeout(go, 200); return; }
    tracker.map.setView([ac.lat, ac.lon], Math.max(tracker.map.getZoom(), 9));
    upsertMarker(ac);
    select(ac.hex);
  };
  go();
}

/** Wing sub-pills ("All T1 · West · East") under the terminal chips, for T1-T3 only. */
function renderWings() {
  const box = $("#wings");
  if (!box) return;
  const wings = state.airport === "xsp" ? [] : Object.entries(GATE_SIDES).filter(([, s]) => s[0] === state.term);
  box.hidden = !wings.length;
  if (!wings.length) { box.innerHTML = ""; return; }
  box.style.setProperty("--tc", `var(--t${state.term})`);
  box.setAttribute("aria-label", `T${state.term} wing`);
  const btn = (wing, label, title) =>
    `<button type="button" data-wing="${esc(wing)}" aria-pressed="${state.wing === wing}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`;
  box.innerHTML = btn("all", `All T${state.term}`, "") +
    wings.map(([letter, s]) => btn(s[1], s[1], `Gates ${letter}`)).join("");
}

/** Board airport switch UI: pressed state, terminal chips (Changi only), Seletar note. */
function applyAirportUI() {
  const xsp = state.airport === "xsp";
  if (xsp && /^[1-4]$/.test(state.term)) setTerm("all");
  setPressed(".seg-airport [data-airport]", "airport", state.airport);
  document.body.dataset.airport = state.airport;
  for (const b of $$('.chips button[data-term]')) {
    if (/^[1-4]$/.test(b.dataset.term)) b.hidden = xsp;
  }
  $("#xsp-note").hidden = !xsp;
  $("#search").placeholder = xsp ? "Search city or flight" : "Search city, airline or flight";
  renderWings();
  renderAirportText();
}

const AIRPORT_TEXT = {
  sin: {
    sub: "SIN · T1–T4",
    intro: "Live departures and arrivals for Singapore Changi Airport, plus a live plane tracker.",
  },
  xsp: {
    sub: "XSP · Seletar",
    intro: "Live departures and arrivals for Seletar Airport, plus a live plane tracker.",
  },
};

/** Header line under the logo and the Board intro: follow the Board's airport (Tracker keeps Changi's). */
function renderAirportText() {
  const t = AIRPORT_TEXT[state.view === "board" && state.airport === "xsp" ? "xsp" : "sin"];
  $(".brand-sub").textContent = t.sub;
  $(".intro").textContent = t.intro;
}

/** Changi <-> Seletar on the Board tab. Seletar has no terminals: a T1-T4 filter resets to All. */
function setAirport(airport) {
  if (airport === state.airport) return;
  state.airport = airport;
  store.set("airport", airport);
  if (airport === "xsp" && /^[1-4]$/.test(state.term)) setTerm("all");
  state.wing = "all";
  state.open.clear();
  state.showEarlier = false;
  applyAirportUI();
  const date = currentDate();
  const have = state.boards.has(boardId(date));
  renderBoard();
  loadBoard(date, { quiet: have, airport });
}

/** Switch the terminal filter (All, T1-T4, Saved, Standby); the wing resets to All. */
function setTerm(term) {
  state.term = term;
  state.wing = "all";
  if (term !== "standby") store.set("term", term); // Standby is live-only, not restored on reload
  setPressed("[data-term]", "term", state.term);
  renderSavedChip();
  renderStandbyChip();
  renderWings();
}

function setPressed(sel, attr, val) {
  $$(sel).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === String(val))));
}

function bindBoard() {
  // "Saved" pill, next to All / T1-T4.
  const chips = $(".chips");
  if (chips && !$('[data-term="saved"]')) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.term = "saved";
    chip.className = "chip-saved";
    chip.setAttribute("aria-pressed", "false");
    chips.appendChild(chip);
    // "Standby N": only shown while aircraft are broadcasting an emergency squawk.
    const sb = document.createElement("button");
    sb.type = "button";
    sb.dataset.term = "standby";
    sb.className = "chip-standby";
    sb.hidden = true;
    sb.setAttribute("aria-pressed", "false");
    chips.appendChild(sb);
  }
  if (state.term === "standby") state.term = "all";
  $("#wings").addEventListener("click", (e) => {
    const b = e.target.closest("[data-wing]");
    if (!b) return;
    state.wing = b.dataset.wing;
    renderWings();
    renderBoard();
  });
  favs = pruneFavs(readFavs());
  renderSavedChip();
  // Saved in another tab: pick it up here too.
  window.addEventListener("storage", (e) => {
    if (e.key === FAV_KEY) { favs = pruneFavs(readFavs()); renderSavedChip(); renderBoard(); }
  });

  $$(".seg-airport [data-airport]").forEach((b) => b.addEventListener("click", () => setAirport(b.dataset.airport)));
  $$("[data-dir]").forEach((b) => b.addEventListener("click", () => {
    state.dir = b.dataset.dir; store.set("dir", state.dir); state.open.clear();
    setPressed("[data-dir]", "dir", state.dir); renderBoard();
  }));
  $$("[data-term]").forEach((b) => b.addEventListener("click", () => {
    setTerm(b.dataset.term); renderBoard();
  }));
  $$("[data-day]").forEach((b) => b.addEventListener("click", () => {
    state.day = Number(b.dataset.day); state.open.clear(); state.showEarlier = false;
    setPressed("[data-day]", "day", state.day);
    const date = currentDate();
    const have = state.boards.has(boardId(date));
    if (have) renderBoard();
    loadBoard(date, { quiet: have, airport: state.airport });
  }));
  let t;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value; renderBoard(); }, 80);
  });
  $("#board").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act) { state.showEarlier = act.dataset.act === "earlier"; renderBoard(); return; }
    const sb = e.target.closest("[data-standby-hex]");
    if (sb) { showStandbyOnMap(sb.dataset.standbyHex); return; }
    const row = e.target.closest(".flight");
    if (!row) return;
    const dir = row.dataset.dir || state.dir;
    const fav = e.target.closest("[data-fav]");
    if (fav) {
      // Star / Save button: never opens or closes the row.
      e.stopPropagation();
      const f = findFlight(dir, row.dataset.key);
      if (f) toggleFav(dir, f);
      return;
    }
    const share = e.target.closest("[data-share]");
    if (share) {
      const f = findFlight(dir, row.dataset.key);
      if (f) shareFlight(dir, f);
      return;
    }
    const track = e.target.closest("[data-track]");
    if (track) { trackFlight(dir, track.dataset.track); return; }
    toggleRow(row.dataset.key);
  });
  // Keyboard: rows act as buttons (Enter / Space); the star is a real button.
  $("#board").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const rowEl = e.target.closest(".f-row");
    if (!rowEl || e.target !== rowEl) return;
    e.preventDefault();
    const key = rowEl.parentElement.dataset.key;
    toggleRow(key);
    const again = $$(".flight").find((el) => el.dataset.key === key);
    if (again) again.querySelector(".f-row").focus();
  });
  setPressed("[data-dir]", "dir", state.dir);
  setPressed("[data-term]", "term", state.term);
  renderWings();
}

function toggleRow(k) {
  state.open.has(k) ? state.open.delete(k) : state.open.add(k);
  renderBoard();
}

/** A flight on the board currently shown (any day), by direction and row key. */
function findFlight(dir, key) {
  const data = state.boards.get(boardId(currentDate()));
  return ((data && data[dir]) || []).find((f) => flightKey(f) === key) || null;
}

// ================================================================ tracker

const tracker = {
  map: null,
  markers: new Map(), // hex -> { marker, ac }
  selected: null,
  timer: null,
  index: null, // matching index built from today's board
  focus: null, // board flight the user asked to track: { ...flight, dir, checked }
  cardFlight: null, // board flight shown on the card, for "View on board"
  pinned: null, // { hex, flight }: a plane found by callsign lookup, so its card keeps the route
  moveTimer: null, // debounce for map pans/zooms
  traffic: [], // latest aircraft positions
  trafficAt: 0, // when they were fetched (ms)
  live: new Set(), // liveKey()s of board flights whose plane is in `traffic`
  squawks: new Map(), // hex -> { sq, polls, at }: emergency codes seen on consecutive polls
  standby: new Map(), // hex -> aircraft flagged as a possible emergency
};

// Emergency transponder codes: [map label, plain words]. Only these three are flagged.
const EMERGENCY_SQUAWKS = {
  7500: ["UNLAWFUL INTERFERENCE", "unlawful interference (hijack code)"],
  7600: ["RADIO FAILURE", "radio failure (lost communication)"],
  7700: ["GENERAL EMERGENCY", "general emergency"],
};
const SQUAWK_MIN_POLLS = 2; // the same code on this many polls in a row before it's flagged

/**
 * Flag airborne aircraft whose emergency squawk has held for SQUAWK_MIN_POLLS
 * consecutive position polls. `at` is the response time, so a cached copy of the
 * same response isn't counted twice. ADS-B's own "emergency" field is ignored.
 */
function updateStandby(list, at) {
  const next = new Map();
  for (const ac of list) {
    if (!ac.hex || ac.gnd || !Object.prototype.hasOwnProperty.call(EMERGENCY_SQUAWKS, ac.sq)) continue;
    const prev = tracker.squawks.get(ac.hex);
    const polls = prev && prev.sq === ac.sq ? (prev.at === at ? prev.polls : prev.polls + 1) : 1;
    next.set(ac.hex, { sq: ac.sq, polls, at });
  }
  tracker.squawks = next;
  tracker.standby = new Map(list.filter((ac) => (next.get(ac.hex)?.polls || 0) >= SQUAWK_MIN_POLLS).map((ac) => [ac.hex, ac]));
}

/** The emergency code this aircraft is flagged for, or null. */
const emergencyOf = (ac) => (ac && tracker.standby.has(ac.hex) ? ac.sq : null);

/** The red "Standby N" pill next to Saved: shown only while N > 0 (or while it's the open view). */
function renderStandbyChip() {
  const chip = $('[data-term="standby"]');
  if (!chip) return;
  const n = tracker.standby.size;
  chip.hidden = !(n > 0 || state.term === "standby");
  chip.innerHTML = `<span>Standby</span><span class="chip-count">${n}</span>`;
  chip.setAttribute("aria-label", `Standby: ${n} aircraft broadcasting a possible emergency code`);
  chip.title = "Aircraft broadcasting an emergency squawk (possible emergency)";
}

const PLANE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.8 0 1.3.8 1.3 1.9V9l7.7 4.4v1.9l-7.7-2.4v4.6l2.1 1.6V21L12 20.1 8.6 21v-1.9l2.1-1.6v-4.6L3 15.3v-1.9L10.7 9V3.9C10.7 2.8 11.2 2 12 2z"/></svg>`;

/** Rebuild the Tracker's callsign index from today's Changi and Seletar boards (whichever are loaded). */
function onTodayBoard() {
  const boards = [state.boards.get(sgtDate(0)), state.boards.get(boardId(sgtDate(0), "xsp"))].filter(Boolean);
  if (!boards.length) return;
  const byExact = new Map(), byNum = new Map();
  for (const data of boards) for (const dir of ["dep", "arr"]) {
    for (const f of data[dir] || []) {
      if (!f.fn || !f.al) continue;
      const num = f.fn.slice(f.al.length).replace(/^0+/, "").replace(/[A-Z]$/, "");
      const rec = { ...f, dir };
      byExact.set(`${f.al}${num}`, [...(byExact.get(`${f.al}${num}`) || []), rec]);
      byNum.set(num, [...(byNum.get(num) || []), rec]);
    }
  }
  tracker.index = { byExact, byNum };
  computeLive();
  if (tracker.selected || tracker.focus) renderCard();
}

function flightTimeMin(f) {
  const ts = f.ats || f.ets;
  return ts ? sgtMinutes(ts.slice(0, 10), ts.slice(11, 16)) : sgtMinutes(f.d, f.st);
}

/** Match an ADS-B callsign (ICAO, e.g. "SIA282") to a board flight. */
function matchFlight(cs) {
  if (!cs || !tracker.index) return null;
  const m = cs.toUpperCase().match(/^([A-Z]{3})0*(\d{1,4})([A-Z]{0,2})$/);
  if (!m) return null;
  const [, icao, num] = m;
  const nowMin = Date.now() / 60e3;
  // A plane within ~25 nm of Changi is minutes from landing or from take-off,
  // so only flights whose (actual/estimated/scheduled) time is near now can match.
  // Generous windows absorb feed lag (e.g. "Gate Closed" while already airborne).
  const plausible = (f) => {
    const t = flightTimeMin(f);
    if (t === null) return false;
    return f.dir === "dep" ? t >= nowMin - 180 && t <= nowMin + 30 : t >= nowMin - 60 && t <= nowMin + 90;
  };
  const closest = (list) => list
    .filter(plausible)
    .map((f) => ({ f, d: Math.abs(flightTimeMin(f) - nowMin) }))
    .sort((a, b) => a.d - b.d)[0];
  const iata = ICAO_TO_IATA[icao];
  if (iata) {
    const hit = tracker.index.byExact.get(`${iata}${num}`);
    const best = hit && closest(hit);
    return best ? best.f : null;
  }
  // Fallback for carriers missing from the map: match the numeric part only.
  // Skip airlines whose callsign prefix we do know (an SQ flight always flies
  // as SIA..., so "MYU912" can never be SQ912).
  const cand = (tracker.index.byNum.get(num) || []).filter((f) => !KNOWN_IATA.has(f.al));
  const best = closest(cand);
  return best ? best.f : null;
}

const sameFlight = (a, b) => Boolean(a && b && a.dir === b.dir && a.fn === b.fn && a.st === b.st);

/** A flight on today's Changi or Seletar board, by direction and row key. */
function findTodayFlight(dir, key) {
  for (const id of [sgtDate(0), boardId(sgtDate(0), "xsp")]) {
    const data = state.boards.get(id);
    const f = ((data && data[dir]) || []).find((x) => flightKey(x) === key);
    if (f) return f;
  }
  return null;
}

/** Board -> tracker: open the map on this flight's plane, or explain why it isn't there. */
function trackFlight(dir, key) {
  const f = findTodayFlight(dir, key);
  if (!f) return;
  if (tracker.selected) select(null);
  tracker.focus = { ...f, dir, checked: false };
  show("tracker");
  renderCard();
  resolveFocus();
  // Not in the current view: a departed flight (or an inbound one) may be far
  // away, so look it up by callsign and jump the map to it.
  if (tracker.focus && wantsLookup(tracker.focus)) lookupFocus(tracker.focus);
}

/** Departed departures and not-yet-landed arrivals can be anywhere: worth a callsign lookup. */
function wantsLookup(f) {
  const s = `${f.raw} ${f.status}`.toLowerCase();
  if (/cancel/.test(s)) return false;
  return f.dir === "dep" ? /depart/.test(s) : !/landed|arrived/.test(s);
}

/** Find the focused flight anywhere by callsign; jump the map to it, or say it's out of coverage. */
async function lookupFocus(f) {
  if (!tracker.map) { setTimeout(() => tracker.focus === f && lookupFocus(f), 200); return; }
  const cs = callsignFor(f);
  if (!cs) { f.lookup = "nocs"; renderCard(); return; }
  f.lookup = "pending";
  renderCard();
  try {
    const data = await getJSON(`/api/traffic?callsign=${encodeURIComponent(cs)}`);
    if (tracker.focus !== f) return; // the user moved on
    const ac = (data.ac || [])[0];
    if (!ac) { f.lookup = "missing"; renderCard(); return; }
    tracker.pinned = { hex: ac.hex, flight: f };
    // Drop any in-flight fetch for the old view so it can't mark this plane as lost.
    trafficSeq++;
    if (trafficAbort) trafficAbort.abort();
    upsertMarker(ac);
    select(ac.hex);
    // Moving the map triggers a fetch of the area around the plane (debounced).
    tracker.map.setView([ac.lat, ac.lon], JUMP_ZOOM);
  } catch (e) {
    if (tracker.focus === f) { f.lookup = "failed"; renderCard(); }
  }
}

/** If the focused flight's plane is on the map, select it and centre on it. */
function resolveFocus() {
  const focus = tracker.focus;
  if (!focus || !tracker.map) return;
  for (const [hex, entry] of tracker.markers) {
    if (entry.lost || !sameFlight(matchFlight(entry.ac.cs), focus)) continue;
    tracker.focus = null;
    select(hex);
    tracker.map.setView([entry.ac.lat, entry.ac.lon], Math.max(tracker.map.getZoom(), 11));
    return;
  }
}

/** Tracker -> board: show the flight's row, expanded, on today's board. */
function viewOnBoard(f) {
  const key = flightKey(f);
  const airport = isXsp(f) ? "xsp" : "sin";
  if (state.airport !== airport) { state.airport = airport; store.set("airport", airport); applyAirportUI(); }
  state.dir = f.dir; store.set("dir", state.dir);
  state.day = 0;
  state.q = ""; $("#search").value = "";
  const keepSaved = state.term === "saved" && isFav(f.dir, f);
  if (state.term !== "all" && state.term !== f.t && !keepSaved) setTerm("all");
  else if (state.wing !== "all" && gateWing(f) !== state.wing) { state.wing = "all"; renderWings(); }
  state.open = new Set([key]);
  if (isEarlier(f)) state.showEarlier = true;
  setPressed("[data-dir]", "dir", state.dir);
  setPressed("[data-day]", "day", state.day);
  setPressed("[data-term]", "term", state.term);
  show("board");
  renderBoard();
  const row = $$(".flight").find((el) => el.dataset.key === key);
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.querySelector(".f-row").focus({ preventScroll: true });
  }
}

function initMap() {
  if (tracker.map || !window.L) return;
  // Mouse-wheel zoom is off so scrolling the page never zooms the map;
  // Ctrl/Cmd + scroll (and trackpad pinch, which sends Ctrl + wheel) still zooms.
  const map = L.map("map", { center: CHANGI, zoom: CHANGI_ZOOM, zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  enableModifierWheelZoom(map);
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://adsb.lol">adsb.lol</a> / <a href="https://airplanes.live">airplanes.live</a>',
  });
  // "Loading map…" until the visible tiles have loaded (or failed), with a safety timeout.
  const loading = $("#map-loading");
  let loadingTimer;
  const doneLoading = () => { clearTimeout(loadingTimer); loading.hidden = true; };
  tiles.on("loading", () => {
    loading.hidden = false;
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(doneLoading, 15e3);
  });
  tiles.on("load", doneLoading);
  loading.hidden = false;
  loadingTimer = setTimeout(doneLoading, 15e3);
  tiles.addTo(map);
  L.marker(CHANGI, {
    icon: L.divIcon({ className: "", html: '<div class="home-dot" title="Singapore Changi (SIN)"></div>', iconSize: [12, 12] }),
    interactive: false, keyboard: false,
  }).addTo(map);
  L.marker(SELETAR, {
    icon: L.divIcon({
      className: "",
      html: '<div class="apt-mark" title="Seletar Airport (WSSL / XSP)"><span class="apt-dot"></span><span class="apt-label">Seletar (XSP)</span></div>',
      iconSize: [10, 10],
    }),
    interactive: false, keyboard: false,
  }).addTo(map);
  // "Near Seletar" starts open where there's room for it next to the plane card.
  if (window.matchMedia("(min-width: 700px)").matches) $("#seletar").open = true;
  map.on("click", () => { if (tracker.selected || tracker.focus) select(null); });
  // Follow the map: when the user pans or zooms, fetch planes around the new
  // centre once the map has settled, and restart the 15 s poll from there.
  map.on("movestart", () => clearTimeout(tracker.moveTimer));
  map.on("moveend", () => {
    clearTimeout(tracker.moveTimer);
    tracker.moveTimer = setTimeout(() => {
      if (state.view !== "tracker") return;
      loadTraffic();
      schedulePoll();
    }, MAP_MOVE_DEBOUNCE_MS);
  });
  // Refresh as a standard map control (top right), so the map stays clean.
  const Refresh = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const bar = L.DomUtil.create("div", "leaflet-bar");
      const btn = L.DomUtil.create("button", "refresh-btn map-refresh", bar);
      btn.type = "button";
      btn.title = "Refresh";
      btn.setAttribute("aria-label", "Refresh aircraft positions");
      btn.innerHTML = REFRESH_SVG;
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(btn, "click", () => refreshNow());
      return bar;
    },
  });
  new Refresh().addTo(map);
  // "Reset to Changi": back to the default view, under the zoom buttons.
  const Reset = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const bar = L.DomUtil.create("div", "leaflet-bar");
      const btn = L.DomUtil.create("button", "map-reset", bar);
      btn.type = "button";
      btn.title = "Reset to Changi";
      btn.setAttribute("aria-label", "Reset map to Changi");
      btn.innerHTML = RESET_SVG;
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(btn, "click", () => map.setView(CHANGI, CHANGI_ZOOM));
      return bar;
    },
  });
  new Reset().addTo(map);
  // "Cargo": show only freighters (tap again for all), under Reset.
  const Cargo = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const bar = L.DomUtil.create("div", "leaflet-bar cargo-bar");
      const btn = L.DomUtil.create("button", "map-cargo", bar);
      btn.type = "button";
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(btn, "click", () => setCargoOnly(!tracker.cargoOnly));
      tracker.cargoBtn = btn;
      return bar;
    },
  });
  new Cargo().addTo(map);
  tracker.map = map;
  renderCargoControl(); // label + filter state (reads tracker.map)
}

const RESET_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/**
 * Zoom with the wheel only while Ctrl or Cmd is held; a plain wheel scrolls
 * the page as usual and shows a short hint over the map.
 */
function enableModifierWheelZoom(map) {
  const el = map.getContainer();
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  let acc = 0, last = 0, hintTimer;
  const hint = L.DomUtil.create("div", "map-hint", el);
  hint.setAttribute("aria-hidden", "true");
  hint.textContent = `Use ${isMac ? "⌘" : "Ctrl"} + scroll to zoom the map`;
  el.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) {
      hint.classList.add("show");
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => hint.classList.remove("show"), 1200);
      return; // let the page scroll
    }
    e.preventDefault(); // stop the browser's own page zoom
    hint.classList.remove("show");
    acc += e.deltaY;
    const now = Date.now();
    if (Math.abs(acc) < 40 || now - last < 120) return;
    const step = acc < 0 ? 1 : -1;
    acc = 0; last = now;
    map.setZoomAround(map.mouseEventToContainerPoint(e), map.getZoom() + step);
  }, { passive: false });
}

const planeClass = (ac, selected, onBoard) =>
  ["plane", ac.gnd ? "ground" : "", onBoard ? "board" : "", isFreighter(ac) ? "cargo" : "", selected ? "sel" : "", emergencyOf(ac) ? "emerg" : ""].join(" ");

/** Marker wrapper classes the Cargo filter hides by (plane markers only, not the airport dots). */
function markCargo(entry) {
  const el = entry.marker.getElement();
  if (!el) return;
  el.classList.add("plane-marker");
  el.classList.toggle("plane-cargo", isFreighter(entry.ac));
}

/** Map label for a flagged aircraft: "SQUAWK 7700 · GENERAL EMERGENCY". */
const squawkLabel = (sq) => `SQUAWK ${sq} · ${EMERGENCY_SQUAWKS[sq][0]}`;

function planeIcon(ac, selected, onBoard) {
  const sq = emergencyOf(ac);
  return L.divIcon({
    className: "",
    html: `<div class="${planeClass(ac, selected, onBoard)}">${PLANE_SVG.replace("<svg", `<svg style="transform:rotate(${ac.trk ?? 0}deg)"`)}</div>${sq ? `<span class="sq-label">${esc(squawkLabel(sq))}</span>` : ""}`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function updatePlane(entry) {
  const el = entry.marker.getElement();
  const { ac } = entry;
  if (!el) return;
  const sq = emergencyOf(ac);
  if ((sq || null) !== (entry.sq || null)) {
    // Flagged or cleared: rebuild the icon (label, title, drawn above other planes).
    entry.sq = sq;
    entry.marker.options.title = markerTitle(ac);
    entry.marker.setZIndexOffset(sq ? 1000 : 0);
    entry.marker.setIcon(planeIcon(ac, tracker.selected === ac.hex, entry.onBoard));
    markCargo(entry);
    return;
  }
  markCargo(entry);
  const box = el.firstElementChild;
  box.className = planeClass(ac, tracker.selected === ac.hex, entry.onBoard);
  box.firstElementChild.style.transform = `rotate(${ac.trk ?? 0}deg)`;
}

/** Fetch aircraft positions: drives the map on the Tracker tab and live marks on the board. */
/**
 * The area to fetch: on the Tracker, the map's centre and a radius covering the
 * visible map (capped at 250 nm); on the Board, null = the Worker's default
 * around Changi (used for the live dots).
 */
function trafficArea() {
  if (state.view !== "tracker" || !tracker.map) return null;
  const c = tracker.map.getCenter();
  const b = tracker.map.getBounds();
  const corners = [b.getNorthEast(), b.getNorthWest(), b.getSouthEast(), b.getSouthWest()];
  const nm = Math.max(...corners.map((p) => haversineKm([c.lat, c.lng], [p.lat, p.lng]))) / 1.852;
  return { lat: c.lat, lon: c.lng, dist: Math.min(MAX_DIST_NM, Math.max(5, Math.ceil(nm))), clipped: nm > MAX_DIST_NM };
}

let trafficSeq = 0;
let trafficAbort = null;

/** Fetch aircraft positions: the visible map area on the Tracker tab, Changi for the board's live marks. */
async function loadTraffic({ fresh = false } = {}) {
  if (document.hidden) return;
  if (state.view === "board" && state.day !== 0) return; // live marks only apply to today
  const area = trafficArea();
  const path = area
    ? `/api/traffic?lat=${area.lat.toFixed(3)}&lon=${area.lon.toFixed(3)}&dist=${area.dist}`
    : "/api/traffic";
  const seq = ++trafficSeq;
  if (trafficAbort) trafficAbort.abort(); // a newer view supersedes any request in flight
  trafficAbort = new AbortController();
  const note = $("#map-note");
  try {
    const data = await getJSON(path, { fresh, signal: trafficAbort.signal });
    if (seq !== trafficSeq) return;
    note.hidden = !data.stale && !(area && area.clipped);
    note.textContent = data.stale ? "Positions delayed" : "Showing 250 nm around the centre · zoom in for the rest";
    tracker.traffic = data.ac || [];
    tracker.trafficAt = data.at || Date.now();
    tracker.trafficArea = data.area || null;
    renderSeletar();
    updateStandby(tracker.traffic, tracker.trafficAt);
    if (state.view === "tracker") applyTraffic(tracker.traffic);
    else if (state.term === "standby") renderBoard();
    renderStandbyChip();
  } catch (e) {
    if (e.name === "AbortError" || seq !== trafficSeq) return;
    note.hidden = false;
    note.textContent = navigator.onLine === false ? "Offline: live positions unavailable" : "Live positions unavailable";
    if (tracker.focus) { tracker.focus.checked = true; tracker.focus.failed = true; renderCard(); }
  }
  computeLive();
}

const markerTitle = (ac) => {
  const sq = emergencyOf(ac);
  return `${ac.cs || "Unknown flight"}${isFreighter(ac) ? ", cargo" : ""}${sq ? `, possible emergency: squawk ${sq} (${EMERGENCY_SQUAWKS[sq][1]})` : ""}`;
};

/** Add or move one plane's marker. */
function upsertMarker(ac) {
  const onBoard = Boolean(matchFlight(ac.cs)) || (tracker.pinned && tracker.pinned.hex === ac.hex);
  let entry = tracker.markers.get(ac.hex);
  if (!entry) {
    const marker = L.marker([ac.lat, ac.lon], {
      icon: planeIcon(ac, false, onBoard),
      keyboard: true,
      title: markerTitle(ac),
      riseOnHover: true,
      zIndexOffset: emergencyOf(ac) ? 1000 : 0,
    }).addTo(tracker.map);
    entry = { marker, ac, onBoard, sq: emergencyOf(ac) };
    marker.on("click", (e) => { L.DomEvent.stopPropagation(e); select(ac.hex); });
    tracker.markers.set(ac.hex, entry);
  } else {
    entry.ac = ac;
    entry.onBoard = onBoard;
    entry.marker.setLatLng([ac.lat, ac.lon]);
  }
  entry.lost = false;
  updatePlane(entry);
  return entry;
}

function applyTraffic(list) {
  if (!tracker.map) return;
  const seen = new Set();
  for (const ac of list) {
    seen.add(ac.hex);
    upsertMarker(ac);
  }
  for (const [hex, entry] of tracker.markers) {
    if (seen.has(hex)) continue;
    if (hex === tracker.selected) { entry.lost = true; continue; }
    entry.marker.remove();
    tracker.markers.delete(hex);
  }
  if (tracker.focus) {
    tracker.focus.checked = true;
    tracker.focus.failed = false;
    resolveFocus(); // also picks the plane up later, e.g. once it takes off
  }
  if (tracker.selected || tracker.focus) renderCard();
  renderCargoControl();
}

// ---------------------------------------------------------------- Cargo filter (Tracker)

/** Freighters among the planes on the map now. */
const cargoCount = () => [...tracker.markers.values()].filter((e) => !e.lost && isFreighter(e.ac)).length;

/** Cargo button label/pressed state, the map's filter class and the "none in view" note. */
function renderCargoControl() {
  const btn = tracker.cargoBtn;
  if (!btn) return;
  const on = Boolean(tracker.cargoOnly);
  const n = cargoCount();
  btn.setAttribute("aria-pressed", String(on));
  btn.innerHTML = on ? `Cargo <span class="cargo-count">${n}</span>` : "Cargo";
  btn.setAttribute("aria-label", on ? `Showing cargo flights only: ${n}. Show all aircraft` : "Show cargo flights only");
  btn.title = on ? "Show all aircraft" : "Show cargo flights only";
  if (tracker.map) tracker.map.getContainer().classList.toggle("cargo-only", on);
  $("#cargo-note").hidden = !(on && n === 0);
}

function setCargoOnly(on) {
  tracker.cargoOnly = on;
  // A selected passenger plane would be hidden: close its card.
  const sel = tracker.selected && tracker.markers.get(tracker.selected);
  if (on && sel && !isFreighter(sel.ac)) select(null);
  renderCargoControl();
}

function select(hex) {
  tracker.focus = null;
  if (tracker.pinned && tracker.pinned.hex !== hex) tracker.pinned = null;
  const prev = tracker.selected;
  tracker.selected = hex;
  for (const h of [prev, hex]) {
    const entry = h && tracker.markers.get(h);
    if (!entry) continue;
    if (h === prev && entry.lost && h !== hex) { entry.marker.remove(); tracker.markers.delete(h); continue; }
    updatePlane(entry);
  }
  renderCard();
}

function routeHTML(f) {
  const home = isXsp(f) ? "Seletar" : "Singapore";
  const from = f.dir === "dep" ? home : f.city || f.ap;
  const to = f.dir === "dep" ? f.city || f.ap : home;
  const time = f.dir === "dep" ? "Departs" : "Arrives";
  return `<p class="c-route">${esc(from)} → ${esc(to)}</p>
    <p class="c-route"><small>${esc(f.fn)} · ${esc(f.an || f.al)} · ${time} ${esc(f.et || f.st)} · ${esc(statusLabel(f))}</small></p>`;
}

/** Friendly explanation when a tracked flight has no live position. */
function notLiveMessage(f) {
  const fn = `<strong>${esc(f.fn)}</strong>`;
  if (!f.checked) return `Looking for ${fn} on the map…`;
  if (f.failed) return `Live positions are unavailable right now, so ${fn} can't be shown. Try again in a minute.`;
  const s = `${f.raw} ${f.status}`.toLowerCase();
  if (/cancel/.test(s)) return `${fn} is cancelled.`;
  if (f.lookup === "pending") return `Looking for ${fn} beyond ${isXsp(f) ? "Seletar" : "Changi"}…`;
  if (f.lookup === "failed") return `Live positions are unavailable right now, so ${fn} can't be found. Try again in a minute.`;
  if (f.lookup === "nocs") {
    return `<span class="c-tag">Out of coverage</span> ${fn} can't be looked up: flightlah doesn't know this airline's radio callsign yet.`;
  }
  if (f.dir === "dep" && (f.lookup === "missing" || /depart/.test(s))) {
    return `<span class="c-tag">Out of coverage</span> ${fn} has departed, but no community ADS-B receiver can see it right now. This is common over oceans and remote areas.`;
  }
  if (f.dir === "arr" && /landed|arrived/.test(s)) return `${fn} has landed and is no longer broadcasting its position.`;
  if (f.dir === "arr" && f.lookup === "missing") {
    return `<span class="c-tag">Out of coverage</span> ${fn} has no signal yet. That's common before it's within range of a community ADS-B receiver. It's due to land at ${esc(f.et || f.st)}.`;
  }
  if (f.dir === "dep") {
    return `${fn} isn't airborne yet. It's due to depart at ${esc(f.et || f.st)}${(f.gate || f.door) ? ` from ${isXsp(f) ? esc(f.door) : `gate ${esc(f.gate)}`}` : ""}. It will appear here once it's airborne.`;
  }
  return `${fn} isn't within range of ${isXsp(f) ? "Seletar" : "Changi"} yet. It's due to land at ${esc(f.et || f.st)} and will appear here once it's close.`;
}

/**
 * Show or fully hide the aircraft card. When closed it is hidden (no peek on
 * tall screens), out of the accessibility tree, and none of its controls can be
 * reached with Tab.
 */
function setCardOpen(open) {
  const card = $("#card");
  card.classList.toggle("show", open);
  card.setAttribute("aria-hidden", String(!open));
  if ("inert" in card) card.inert = !open;
  for (const el of card.querySelectorAll("button, a, [tabindex]")) {
    if (open) {
      el.removeAttribute("tabindex");
      if (el.tagName === "BUTTON") el.disabled = false;
    } else {
      el.setAttribute("tabindex", "-1");
      if (el.tagName === "BUTTON") el.disabled = true;
    }
  }
}

function renderCard() {
  const card = $("#card");
  const entry = tracker.selected && tracker.markers.get(tracker.selected);
  const boardLink = '<button class="c-link" type="button" data-board>View on board →</button>';
  if (!entry && tracker.focus) {
    const f = tracker.focus;
    tracker.cardFlight = f;
    $("#card-body").innerHTML = `
      <div class="c-head">
        <span class="c-cs">${esc(f.fn)}</span>
        <span class="c-type">${esc([f.an || f.al, acName(f.ac)].filter(Boolean).join(" · "))}</span>
      </div>
      ${routeHTML(f)}
      <p class="c-msg">${notLiveMessage(f)}</p>
      ${boardLink}`;
    setCardOpen(true);
    return;
  }
  if (!entry) {
    tracker.cardFlight = null;
    setCardOpen(false);
    return;
  }
  const { ac } = entry;
  const f = matchFlight(ac.cs) || (tracker.pinned && tracker.pinned.hex === ac.hex ? tracker.pinned.flight : null);
  const fromXsp = isXsp(f); // a Seletar flight: distance from Seletar, not Changi
  const km = haversineKm(fromXsp ? SELETAR : CHANGI, [ac.lat, ac.lon]);
  const alt = ac.gnd ? "Ground" : ac.alt != null ? `${Math.round(ac.alt).toLocaleString("en-US")} ft` : "—";
  const spd = ac.gs != null ? `${Math.round(ac.gs)} kt` : "—";

  tracker.cardFlight = f;
  const route = f ? routeHTML(f) : "";
  $("#card-body").innerHTML = `
    <div class="c-head">
      <span class="c-cs${ac.cs ? "" : " c-unknown"}">${esc(ac.cs || "Unknown flight")}</span>
      ${isFreighter(ac) ? '<span class="c-cargo">CARGO</span>' : ""}
      <span class="c-type">${esc([acName(ac.t), ac.reg].filter(Boolean).join(" · ") || "Unknown type")}</span>
    </div>
    ${route}
    ${emergencyOf(ac) ? `<p class="c-emerg"><strong>${esc(squawkLabel(ac.sq))}</strong><br>Possible emergency: this aircraft is broadcasting squawk ${esc(ac.sq)} (${esc(EMERGENCY_SQUAWKS[ac.sq][1])}). A squawk is a broadcast, not a confirmed incident.</p>` : ""}
    <dl class="c-stats">
      <div class="kv"><dt>Altitude</dt><dd>${esc(alt)}</dd></div>
      <div class="kv"><dt>Speed</dt><dd>${esc(spd)}</dd></div>
      <div class="kv"><dt>From ${fromXsp ? "XSP" : "SIN"}</dt><dd>${km.toFixed(1)} km</dd></div>
    </dl>
    ${entry.lost ? `<p class="c-lost">Signal lost — last known position.</p>` : ""}
    ${f ? boardLink : ""}`;
  setCardOpen(true);
}

/** (Re)start the Tracker's 15 s position poll for whatever area the map shows. */
function schedulePoll() {
  clearInterval(tracker.timer);
  tracker.timer = setInterval(() => loadTraffic(), TRAFFIC_REFRESH_MS);
}

/** "Near Seletar": aircraft in the latest traffic within NEAR_SELETAR_NM of Seletar. */
function renderSeletar() {
  const box = $("#seletar-list");
  if (!box) return;
  const area = tracker.trafficArea;
  // The Tracker fetches the area the map shows; Seletar may be outside it after a long pan.
  const covered = !area || haversineKm([area.lat, area.lon], SELETAR) / 1.852 + NEAR_SELETAR_NM <= area.dist;
  const near = covered
    ? tracker.traffic
      .map((ac) => ({ ac, nm: haversineKm(SELETAR, [ac.lat, ac.lon]) / 1.852 }))
      .filter((x) => x.nm <= NEAR_SELETAR_NM)
      .sort((a, b) => a.nm - b.nm)
    : [];
  $("#seletar-count").textContent = covered && tracker.trafficAt ? `· ${near.length}` : "";
  if (!covered) {
    box.innerHTML = `<p class="near-empty">Seletar is outside the area the map is showing. Tap Seletar above to see it.</p>`;
    return;
  }
  if (!near.length) {
    box.innerHTML = `<p class="near-empty">${tracker.trafficAt ? "No aircraft with ADS-B near Seletar right now." : "Loading aircraft…"}</p>`;
    return;
  }
  box.innerHTML = `<ul>${near.map(({ ac }) => {
    const alt = ac.gnd ? "Ground" : ac.alt != null ? `${Math.round(ac.alt).toLocaleString("en-US")} ft` : "—";
    const spd = ac.gs != null ? `${Math.round(ac.gs)} kt` : "—";
    const firefly = /^FFM/.test(ac.cs || "") ? `<span class="near-tag">Firefly</span>` : "";
    const f = matchFlight(ac.cs);
    const flight = f ? ` · ${esc(f.fn)} ${f.dir === "dep" ? "to" : "from"} ${esc(f.city || f.ap)}` : "";
    return `<li><button type="button" data-near-hex="${esc(ac.hex)}">
      <span class="near-id"><span class="near-cs${ac.cs ? "" : " c-unknown"}">${esc(ac.cs || "Unknown")}</span>${firefly}</span>
      <span class="near-num">${esc(alt)}</span>
      <span class="near-type">${esc(acName(ac.t) || "Unknown type")}${flight}</span>
      <span class="near-num">${esc(spd)}</span>
    </button></li>`;
  }).join("")}</ul>`;
}

/** Tracker header buttons: zoom to Seletar or back to Changi (Reset stays as it was). */
function goToAirport(where) {
  if (!tracker.map) return;
  if (where === "seletar") {
    tracker.map.setView(SELETAR, SELETAR_ZOOM);
    if (window.matchMedia("(min-width: 700px)").matches) $("#seletar").open = true; // phones: tap to open
  } else {
    tracker.map.setView(CHANGI, CHANGI_ZOOM);
  }
}

function startTracker() {
  initMap();
  if (!tracker.map) { setTimeout(startTracker, 200); return; } // Leaflet still loading
  tracker.map.invalidateSize();
  renderSeletar();
  if (!state.boards.has(sgtDate(0))) loadBoard(sgtDate(0), { quiet: true });
  if (!state.boards.has(boardId(sgtDate(0), "xsp"))) loadBoard(sgtDate(0), { quiet: true, airport: "xsp" });
  loadTraffic();
  schedulePoll();
}
function stopTracker() { clearInterval(tracker.timer); tracker.timer = null; clearTimeout(tracker.moveTimer); }

// ================================================================ refresh

let refreshing = null;

/** A brief, subtle pulse on the refresh icon(s) when an automatic refresh runs. */
function pulseRefresh() {
  for (const b of $$(".refresh-btn")) {
    b.classList.remove("pulse");
    void b.offsetWidth; // restart the animation
    b.classList.add("pulse");
  }
}

function setSpinning(on) {
  for (const b of $$(".refresh-btn")) {
    b.classList.toggle("spinning", on);
    b.disabled = on;
    b.setAttribute("aria-busy", String(on));
  }
}

/**
 * Re-fetch what's on screen without reloading the page. Board tab: the shown
 * day's board plus positions for live marks. Tracker tab: positions plus
 * today's board (used to match planes to flights).
 * `manual` shows the spinner and bypasses the browser cache.
 */
function refreshNow({ manual = true } = {}) {
  if (refreshing) return refreshing;
  const started = Date.now();
  if (manual) setSpinning(true); else pulseRefresh();
  const onBoard = state.view === "board";
  const date = onBoard ? currentDate() : sgtDate(0);
  // Only automatic refreshes animate changed rows (split-flap); a manual refresh just updates.
  const jobs = [loadBoard(date, { quiet: true, fresh: manual, airport: onBoard ? state.airport : "sin", animate: !manual && onBoard }), loadTraffic({ fresh: manual })];
  refreshing = Promise.allSettled(jobs).then(async () => {
    if (manual) {
      const wait = MIN_SPIN_MS - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      setSpinning(false);
    }
    state.lastRefresh = Date.now();
    refreshing = null;
  });
  return refreshing;
}

// ================================================================ share links
//
// ?flight=SQ123&day=2026-11-08&dir=arr opens the board on that day and direction,
// scrolls to the flight, highlights it briefly and expands it. `day` also accepts
// today / yesterday / tomorrow. Links use the flight's own date so a link shared
// today still points at the same flight tomorrow.

const SHARE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function shareUrl(f, dir) {
  const q = new URLSearchParams({ flight: f.fn, day: f.d, dir, ...(isXsp(f) ? { airport: "xsp" } : {}) });
  return `${location.origin}${location.pathname}?${q}`;
}

async function shareFlight(dir, f) {
  const url = shareUrl(f, dir);
  const when = fmtDay.format(new Date(f.d + "T00:00:00Z"));
  const home = isXsp(f) ? "Singapore Seletar" : "Singapore";
  const text = dir === "dep"
    ? `${f.fn} ${home} → ${f.city || f.ap}, departs ${shownTime(f)} on ${when}`
    : `${f.fn} ${f.city || f.ap} → ${home}, arrives ${shownTime(f)} on ${when}`;
  if (navigator.share) {
    try { await navigator.share({ title: `${f.fn} · flightlah`, text, url }); return; }
    catch (e) { if (e && e.name === "AbortError") return; /* else fall back to copying */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast(`Copy this link: ${url}`);
  }
}

/** Read a share link from the URL (and remove it, so a reload doesn't repeat it). */
function readShareLink() {
  const q = new URLSearchParams(location.search);
  const fn = (q.get("flight") || "").toUpperCase().replace(/\s+/g, "");
  if (!fn) return null;
  history.replaceState(null, "", location.pathname);
  const dirRaw = (q.get("dir") || "").toLowerCase();
  const dir = dirRaw === "dep" || dirRaw === "arr" ? dirRaw : null;
  const dayRaw = (q.get("day") || "today").toLowerCase();
  let offset = { yesterday: -1, today: 0, tomorrow: 1 }[dayRaw];
  if (offset === undefined && /^\d{4}-\d{2}-\d{2}$/.test(dayRaw)) {
    offset = Math.round((Date.parse(dayRaw) - Date.parse(sgtDate(0))) / 86400e3);
  }
  const airport = (q.get("airport") || "").toLowerCase() === "xsp" ? "xsp" : "sin";
  return { fn, dir, airport, offset: Number.isFinite(offset) ? offset : NaN };
}

/** Once the linked day's board is loaded: open, scroll to and highlight the flight. */
function resolveShareLink() {
  const link = state.pendingShare;
  const data = state.boards.get(boardId(currentDate()));
  if (!link || !data) return;
  state.pendingShare = null;
  const dirs = link.dir ? [link.dir] : ["dep", "arr"];
  let found = null;
  for (const dir of dirs) {
    const f = (data[dir] || []).find((x) => (x.fn || "").toUpperCase() === link.fn);
    if (f) { found = { dir, f }; break; }
  }
  if (!found) { toast("Flight not found for that day"); return; }
  const { dir, f } = found;
  const key = flightKey(f);
  state.dir = dir;
  setPressed("[data-dir]", "dir", state.dir);
  state.open = new Set([key]);
  if (isEarlier(f)) state.showEarlier = true;
  renderBoard();
  const row = $$(".flight").find((el) => el.dataset.key === key && el.dataset.dir === dir);
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 2600);
  row.querySelector(".f-row").focus({ preventScroll: true });
}

// ================================================================ views

function show(view) {
  const prev = state.view;
  state.view = view;
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === view)));
  $("#view-board").hidden = view !== "board";
  $("#view-tracker").hidden = view !== "tracker";
  document.body.classList.toggle("tracking", view === "tracker");
  history.replaceState(null, "", view === "tracker" ? "#tracker" : location.pathname + location.search);
  renderAirportText();
  if (view === "tracker") startTracker();
  else {
    stopTracker();
    if (prev === "tracker") loadTraffic(); // live dots use the area around Changi, not the map's
  }
}

function init() {
  bindBoard();
  $$(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));
  $(".card-close").addEventListener("click", () => select(null));
  $("#trk-head").addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (b) goToAirport(b.dataset.goto);
  });
  $("#seletar-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-near-hex]");
    if (b && tracker.markers.has(b.dataset.nearHex)) select(b.dataset.nearHex);
  });
  setCardOpen(false); // closed card: hidden and out of the Tab order from the start
  $("#card-body").addEventListener("click", (e) => {
    if (e.target.closest("[data-board]") && tracker.cardFlight) viewOnBoard(tracker.cardFlight);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (tracker.selected || tracker.focus)) select(null); });

  $("#refresh").addEventListener("click", () => refreshNow());
  const onWideChange = () => { if (state.view === "board") renderBoard(); };
  if (WIDE_MQ.addEventListener) WIDE_MQ.addEventListener("change", onWideChange);
  else if (WIDE_MQ.addListener) WIDE_MQ.addListener(onWideChange);

  // Opened from a share link: board tab, that direction and day, all terminals.
  const link = readShareLink();
  if (link) {
    if (link.offset >= -1 && link.offset <= 1) {
      state.view = "board";
      state.day = link.offset;
      if (link.dir) state.dir = link.dir;
      state.term = "all";
      state.wing = "all";
      state.q = "";
      state.airport = link.airport;
      setPressed("[data-day]", "day", state.day);
      setPressed("[data-dir]", "dir", state.dir);
      setPressed("[data-term]", "term", state.term);
      renderWings();
      state.pendingShare = link;
    } else {
      toast("Flight not found for that day");
    }
  }

  applyAirportUI();
  loadBoard(currentDate(), { airport: state.airport });
  if (state.view === "board") loadTraffic(); // the Tracker fetches its own area when it starts
  state.lastRefresh = Date.now();
  // Auto-refresh every 2 minutes while the page is visible (the Tracker tab
  // also refreshes positions every 15 s on its own timer).
  setInterval(() => {
    if (!document.hidden) refreshNow({ manual: false });
  }, AUTO_REFRESH_MS);
  // Coming back to the tab: catch up if the last refresh is older than the interval.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - (state.lastRefresh || 0) >= AUTO_REFRESH_MS) refreshNow({ manual: false });
  });

  show(state.view);

  // Installable app + offline fallback (see sw.js). Back online: refresh straight away.
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("service worker:", e));
    // A board that was too slow (so the saved copy was shown) has now arrived: show it.
    navigator.serviceWorker.addEventListener("message", (e) => {
      const m = e.data;
      if (!m || m.type !== "board-fresh" || !m.body || !m.body.date) return;
      const id = boardIdOf(m.body);
      const shown = state.boards.get(id);
      if (shown && !shown.offline && shown.updatedAt > m.body.updatedAt) return; // already have newer
      state.boards.set(id, m.body);
      state.fetchedAt.set(id, Date.now());
      state.errors.delete(id);
      const y = window.scrollY;
      renderBoard();
      if (window.scrollY !== y) window.scrollTo(0, y);
      if (m.body.date === sgtDate(0)) onTodayBoard();
    });
  }
  window.addEventListener("online", () => refreshNow({ manual: false }));
}

document.addEventListener("DOMContentLoaded", init);
