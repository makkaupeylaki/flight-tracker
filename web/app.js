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
  if (/board|gate open|gate clos|last call|new gate|go to gate/.test(s)) return "warn";
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
    ? `<span class="delay-tag late" title="${basis} time is ${m} min later than scheduled">Delayed +${m}m</span>`
    : `<span class="delay-tag early" title="${basis} time is ${-m} min earlier than scheduled">Early -${-m}m</span>`;
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
  day: 0,
  q: "",
  open: new Set(),
  showEarlier: false,
  boards: new Map(), // date -> payload
  fetchedAt: new Map(), // date -> when the page last fetched that board (ms)
  loading: false,
  error: null,
};

// ================================================================ board

async function loadBoard(date, { quiet = false, fresh = false } = {}) {
  const today = sgtDate(0);
  const path = date === today ? "/api/board" : `/api/board?date=${date}`;
  if (!quiet) { state.loading = true; renderBoard(); }
  try {
    const data = await getJSON(path, { fresh });
    state.boards.set(date, data);
    state.fetchedAt.set(date, Date.now());
    state.error = null;
  } catch (e) {
    state.error = e.message;
  } finally {
    state.loading = false;
  }
  // Re-render in place: filters, open rows and "earlier flights" live in `state`;
  // keep the scroll position in case the list height changed.
  const y = window.scrollY;
  renderBoard();
  if (quiet && window.scrollY !== y) window.scrollTo(0, y);
  if (date === today) onTodayBoard();
  if (state.pendingShare && date === currentDate()) resolveShareLink();
}

function currentDate() { return sgtDate(state.day); }

function filteredFlights(data, dir = state.dir) {
  // Sort by the time each row shows, so retimed flights sit where their time says.
  const list = [...((data && data[dir]) || [])]
    .sort((a, b) => effectiveTs(a).localeCompare(effectiveTs(b)) || (a.fn || "").localeCompare(b.fn || ""));
  const q = state.q.trim().toLowerCase();
  return list.filter((f) => {
    if (state.term === "saved") { if (!isFav(dir, f)) return false; }
    else if (state.term !== "all" && f.t !== state.term) return false;
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

/** Arrival gate text: "T2 North · Gate E8", or just "Gate G9" when the letter has no side. */
function arrivalGateHTML(gate) {
  const g = plainGate(gate);
  const side = GATE_SIDES[g[0]];
  return side
    ? `<span class="t${side[0]}">T${side[0]} ${side[1]}</span> · Gate ${esc(g)}`
    : `Gate ${esc(g)}`;
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

function detailHTML(f, dir = state.dir) {
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
      ? `${esc(f.gate)}${gateChanged(f) ? `<small class="gate-was">Gate changed, was ${esc(f.gate_was)}</small>` : ""}`
      : "—") : (f.gate ? kv("Gate", `${arrivalGateHTML(f.gate)}${gateChanged(f) ? `<small class="gate-was">Gate changed, was ${esc(f.gate_was)}</small>` : ""}`) : "") + kv("Belt", f.belt ? `${esc(f.belt)}${f.belt_status ? ` <small>${esc(f.belt_status)}</small>` : ""}` : "—")}
    ${dep ? kv("Check-in row", esc(f.row) || "—") : ""}
    ${kv("Scheduled", time(f.st, `${f.d} ${f.st}`))}
    ${kv("Estimated", time(f.et, f.ets) || "—")}
    ${kv("Actual", time(f.at, f.ats) || "—")}
    ${kv("Aircraft", esc(f.ac) || "—")}
    ${kv("Terminal", f.t ? `<span class="${termClass(f.t)}">T${esc(f.t)}</span>` : "Not assigned yet")}
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
  const gate = dep && f.gate
    ? `<span class="f-gate${moved ? " changed" : ""}" title="Gate ${esc(f.gate)}${moved ? `, changed from ${esc(f.gate_was)}` : ""}">${esc(f.gate)}</span>`
    : "";
  const note = moved ? `<span class="f-note">Gate changed, was ${esc(f.gate_was)}</span>` : "";
  // Arrivals: terminal side and gate on a second line, only once Changi publishes the gate.
  const gha = groundHandler(f);
  const side = !dep && f.gate
    ? `<span class="f-sub f-gate${moved ? " changed" : ""}">${arrivalGateHTML(f.gate)}${gha ? ` · <span class="f-gha" title="Ground handler">${esc(gha)}</span>` : ""}</span>`
    : "";
  // The row is a focusable element acting as a button (Enter/Space open it), so the
  // star can be a real button inside it without opening the row.
  return `<div class="flight${open ? " open" : ""}${live ? " live" : ""}${saved ? " saved" : ""}" data-key="${esc(key)}" data-dir="${dir}">
    <div class="f-row" role="button" tabindex="0" aria-expanded="${open}">
      <span class="live-tag" title="On the map now"><span class="sr-only">Live on map. </span></span>
      <span class="f-time${changed ? " changed" : ""}" title="${changed ? `Scheduled ${esc(f.st)}, estimated ${esc(f.et)}` : "Scheduled"}">${esc(shownTime(f))}</span>
      <span class="f-flight"><span class="f-fn">${esc(f.fn)}</span></span>
      <span class="f-city">${esc(f.city || f.ap)}</span>
      <span class="f-where"><span class="f-term ${termClass(f.t)}"${f.t ? "" : ' title="Terminal not assigned yet"'}>${termLabel(f.t)}</span>${gate}</span>
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
  const fetched = state.fetchedAt.get(data.date) || data.updatedAt;
  const t = fmtSGT.format(new Date(fetched));
  const dataTime = fmtSGT.format(new Date(data.updatedAt));
  const old = Date.now() - data.updatedAt > OLD_DATA_MS;
  const stale = data.stale || state.error;
  el.title = `Flight data last changed at ${dataTime} SGT`;
  // One line: when the page last updated, then the most useful second fact.
  const tail = stale
    ? `<span class="stale" title="${esc(data.error || state.error || "")}">data may be slightly old</span>`
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
    : more + `<p class="empty">${state.q ? "No flights match your search." : "No flights."}</p>`;
  return `<section class="board-col" aria-label="${title}"><h2 class="col-head">${title}</h2>${body}</section>`;
}

function renderBoard() {
  const date = currentDate();
  const data = state.boards.get(date);
  const box = $("#board");
  box.setAttribute("aria-busy", String(state.loading));
  renderUpdated(data);

  if (!data) {
    box.innerHTML = state.loading
      ? `<p class="empty">Loading flights…</p>`
      : `<p class="empty error">Couldn't load flights${state.error ? `: ${esc(state.error)}` : ""}.</p>`;
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
    : more + `<p class="empty">${state.q ? "No flights match your search." : "No flights."}</p>`;
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
  }
  favs = pruneFavs(readFavs());
  renderSavedChip();
  // Saved in another tab: pick it up here too.
  window.addEventListener("storage", (e) => {
    if (e.key === FAV_KEY) { favs = pruneFavs(readFavs()); renderSavedChip(); renderBoard(); }
  });

  $$("[data-dir]").forEach((b) => b.addEventListener("click", () => {
    state.dir = b.dataset.dir; store.set("dir", state.dir); state.open.clear();
    setPressed("[data-dir]", "dir", state.dir); renderBoard();
  }));
  $$("[data-term]").forEach((b) => b.addEventListener("click", () => {
    state.term = b.dataset.term; store.set("term", state.term);
    setPressed("[data-term]", "term", state.term); renderSavedChip(); renderBoard();
  }));
  $$("[data-day]").forEach((b) => b.addEventListener("click", () => {
    state.day = Number(b.dataset.day); state.open.clear(); state.showEarlier = false;
    setPressed("[data-day]", "day", state.day);
    const date = currentDate();
    if (state.boards.has(date)) renderBoard();
    loadBoard(date, { quiet: state.boards.has(date) });
  }));
  let t;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value; renderBoard(); }, 80);
  });
  $("#board").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act) { state.showEarlier = act.dataset.act === "earlier"; renderBoard(); return; }
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
}

function toggleRow(k) {
  state.open.has(k) ? state.open.delete(k) : state.open.add(k);
  renderBoard();
}

/** A flight on the board currently shown (any day), by direction and row key. */
function findFlight(dir, key) {
  const data = state.boards.get(currentDate());
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
};

const PLANE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.8 0 1.3.8 1.3 1.9V9l7.7 4.4v1.9l-7.7-2.4v4.6l2.1 1.6V21L12 20.1 8.6 21v-1.9l2.1-1.6v-4.6L3 15.3v-1.9L10.7 9V3.9C10.7 2.8 11.2 2 12 2z"/></svg>`;

function onTodayBoard() {
  const data = state.boards.get(sgtDate(0));
  if (!data) return;
  const byExact = new Map(), byNum = new Map();
  for (const dir of ["dep", "arr"]) {
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

function findTodayFlight(dir, key) {
  const data = state.boards.get(sgtDate(0));
  return ((data && data[dir]) || []).find((f) => flightKey(f) === key) || null;
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
  state.dir = f.dir; store.set("dir", state.dir);
  state.day = 0;
  state.q = ""; $("#search").value = "";
  const keepSaved = state.term === "saved" && isFav(f.dir, f);
  if (state.term !== "all" && state.term !== f.t && !keepSaved) { state.term = "all"; store.set("term", state.term); }
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
  tracker.map = map;
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

function planeIcon(ac, selected, onBoard) {
  const cls = ["plane", ac.gnd ? "ground" : "", onBoard ? "board" : "", selected ? "sel" : ""].join(" ");
  return L.divIcon({
    className: "",
    html: `<div class="${cls}">${PLANE_SVG.replace("<svg", `<svg style="transform:rotate(${ac.trk ?? 0}deg)"`)}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function updatePlane(entry) {
  const el = entry.marker.getElement();
  const { ac } = entry;
  if (!el) return;
  const box = el.firstElementChild;
  box.className = ["plane", ac.gnd ? "ground" : "", entry.onBoard ? "board" : "", tracker.selected === ac.hex ? "sel" : ""].join(" ");
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
    if (state.view === "tracker") applyTraffic(tracker.traffic);
  } catch (e) {
    if (e.name === "AbortError" || seq !== trafficSeq) return;
    note.hidden = false;
    note.textContent = "Live positions unavailable";
    if (tracker.focus) { tracker.focus.checked = true; tracker.focus.failed = true; renderCard(); }
  }
  computeLive();
}

/** Add or move one plane's marker. */
function upsertMarker(ac) {
  const onBoard = Boolean(matchFlight(ac.cs)) || (tracker.pinned && tracker.pinned.hex === ac.hex);
  let entry = tracker.markers.get(ac.hex);
  if (!entry) {
    const marker = L.marker([ac.lat, ac.lon], {
      icon: planeIcon(ac, false, onBoard),
      keyboard: true,
      title: ac.cs || "Unknown flight",
      riseOnHover: true,
    }).addTo(tracker.map);
    entry = { marker, ac, onBoard };
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
  const from = f.dir === "dep" ? "Singapore" : f.city || f.ap;
  const to = f.dir === "dep" ? f.city || f.ap : "Singapore";
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
  if (f.lookup === "pending") return `Looking for ${fn} beyond Changi…`;
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
    return `${fn} isn't airborne yet. It's due to depart at ${esc(f.et || f.st)}${f.gate ? ` from gate ${esc(f.gate)}` : ""}. It will appear here once it's airborne.`;
  }
  return `${fn} isn't within range of Changi yet. It's due to land at ${esc(f.et || f.st)} and will appear here once it's close.`;
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
        <span class="c-type">${esc([f.an || f.al, f.ac].filter(Boolean).join(" · "))}</span>
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
  const km = haversineKm(CHANGI, [ac.lat, ac.lon]);
  const alt = ac.gnd ? "Ground" : ac.alt != null ? `${Math.round(ac.alt).toLocaleString("en-US")} ft` : "—";
  const spd = ac.gs != null ? `${Math.round(ac.gs)} kt` : "—";

  tracker.cardFlight = f;
  const route = f ? routeHTML(f) : "";
  $("#card-body").innerHTML = `
    <div class="c-head">
      <span class="c-cs${ac.cs ? "" : " c-unknown"}">${esc(ac.cs || "Unknown flight")}</span>
      <span class="c-type">${esc([ac.t, ac.reg].filter(Boolean).join(" · ") || "Unknown type")}</span>
    </div>
    ${route}
    <dl class="c-stats">
      <div class="kv"><dt>Altitude</dt><dd>${esc(alt)}</dd></div>
      <div class="kv"><dt>Speed</dt><dd>${esc(spd)}</dd></div>
      <div class="kv"><dt>From SIN</dt><dd>${km.toFixed(1)} km</dd></div>
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

function startTracker() {
  initMap();
  if (!tracker.map) { setTimeout(startTracker, 200); return; } // Leaflet still loading
  tracker.map.invalidateSize();
  if (!state.boards.has(sgtDate(0))) loadBoard(sgtDate(0), { quiet: true });
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
  const date = state.view === "board" ? currentDate() : sgtDate(0);
  const jobs = [loadBoard(date, { quiet: true, fresh: manual }), loadTraffic({ fresh: manual })];
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
  const q = new URLSearchParams({ flight: f.fn, day: f.d, dir });
  return `${location.origin}${location.pathname}?${q}`;
}

async function shareFlight(dir, f) {
  const url = shareUrl(f, dir);
  const when = fmtDay.format(new Date(f.d + "T00:00:00Z"));
  const text = dir === "dep"
    ? `${f.fn} Singapore → ${f.city || f.ap}, departs ${shownTime(f)} on ${when}`
    : `${f.fn} ${f.city || f.ap} → Singapore, arrives ${shownTime(f)} on ${when}`;
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
  return { fn, dir, offset: Number.isFinite(offset) ? offset : NaN };
}

/** Once the linked day's board is loaded: open, scroll to and highlight the flight. */
function resolveShareLink() {
  const link = state.pendingShare;
  const data = state.boards.get(currentDate());
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
      state.q = "";
      setPressed("[data-day]", "day", state.day);
      setPressed("[data-dir]", "dir", state.dir);
      setPressed("[data-term]", "term", state.term);
      state.pendingShare = link;
    } else {
      toast("Flight not found for that day");
    }
  }

  loadBoard(currentDate());
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
}

document.addEventListener("DOMContentLoaded", init);
