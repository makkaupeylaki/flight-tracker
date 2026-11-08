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
async function getJSON(path, { fresh = false } = {}) {
  const res = await fetch(API + path, { headers: { Accept: "application/json" }, cache: fresh ? "no-cache" : "default" });
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

// Terminals: "1"-"4", or null when the feed hasn't assigned one yet.
const termLabel = (t) => (t ? `T${t}` : "TBC");
const termClass = (t) => (t ? `t${t}` : "tbc");
const flightKey = (f) => `${f.fn}|${f.st}`;

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
}

function currentDate() { return sgtDate(state.day); }

function filteredFlights(data) {
  const list = (data && data[state.dir]) || [];
  const q = state.q.trim().toLowerCase();
  return list.filter((f) => {
    if (state.term !== "all" && f.t !== state.term) return false;
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
const gateChanged = (f, dir = state.dir) => dir === "dep" && Boolean(f.gate && f.gate_was);

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

function detailHTML(f) {
  const kv = (k, v) => (v ? `<div class="kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>` : "");
  const time = (hm, ts) => {
    if (!hm) return "";
    const d = ts && ts.slice(0, 10);
    return d && d !== f.d ? `${esc(hm)} <small>${esc(fmtDay.format(new Date(d + "T00:00:00Z")))}</small>` : esc(hm);
  };
  const place = `${esc(f.city || f.ap)} <small>${esc([f.ap, f.cc].filter(Boolean).join(" · "))}</small>`;
  const dep = state.dir === "dep";
  return `<dl class="f-detail">
    ${kv(dep ? "To" : "From", place)}
    ${kv("Airline", esc(f.an || f.al))}
    ${dep ? kv("Gate", f.gate
      ? `${esc(f.gate)}${gateChanged(f) ? `<small class="gate-was">Gate changed, was ${esc(f.gate_was)}</small>` : ""}`
      : "—") : kv("Belt", f.belt ? `${esc(f.belt)}${f.belt_status ? ` <small>${esc(f.belt_status)}</small>` : ""}` : "—")}
    ${dep ? kv("Check-in row", esc(f.row) || "—") : ""}
    ${kv("Scheduled", time(f.st, `${f.d} ${f.st}`))}
    ${kv("Estimated", time(f.et, f.ets) || "—")}
    ${kv("Actual", time(f.at, f.ats) || "—")}
    ${kv("Aircraft", esc(f.ac) || "—")}
    ${kv("Terminal", f.t ? `<span class="${termClass(f.t)}">T${esc(f.t)}</span>` : "Not assigned yet")}
  </dl>
  ${gettingThereHTML(f, dep)}
  ${state.day === 0 ? `<div class="f-actions"><button class="track-btn" type="button" data-track="${esc(flightKey(f))}">${trackLabel(isLive(f))}</button></div>` : ""}`;
}

function rowHTML(f) {
  const key = flightKey(f);
  const open = state.open.has(key);
  const changed = f.et && f.et !== f.st && !isFinished(f);
  const live = isLive(f);
  const dep = state.dir === "dep";
  // Flag the change on the row only while people may still be heading to the gate;
  // the detail keeps it after departure.
  const moved = gateChanged(f) && !isFinished(f);
  const gate = dep && f.gate
    ? `<span class="f-gate${moved ? " changed" : ""}" title="Gate ${esc(f.gate)}${moved ? `, changed from ${esc(f.gate_was)}` : ""}">${esc(f.gate)}</span>`
    : "";
  const note = moved ? `<span class="f-note">Gate changed, was ${esc(f.gate_was)}</span>` : "";
  return `<div class="flight${open ? " open" : ""}${live ? " live" : ""}" data-key="${esc(key)}">
    <button class="f-row" aria-expanded="${open}">
      <span class="live-tag" title="On the map now"><span class="sr-only">Live on map. </span></span>
      <span class="f-time${changed ? " changed" : ""}" title="${changed ? `Scheduled ${esc(f.st)}, estimated ${esc(f.et)}` : "Scheduled"}">${esc(changed ? f.et : f.st)}</span>
      <span class="f-flight"><span class="f-fn">${esc(f.fn)}</span><span class="f-al">${esc(f.an || "")}</span></span>
      <span class="f-city">${esc(f.city || f.ap)}</span>
      <span class="f-where"><span class="f-term ${termClass(f.t)}"${f.t ? "" : ' title="Terminal not assigned yet"'}>${termLabel(f.t)}</span>${gate}</span>
      <span class="pill ${statusClass(f)}">${esc(f.status)}</span>
      ${note}
    </button>
    ${open ? detailHTML(f) : ""}
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
    const live = state.day === 0 && tracker.live.has(`${state.dir}|${el.dataset.key}`);
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
  el.title = `Flight data as of ${dataTime} SGT`;
  el.innerHTML = `Last updated ${esc(t)} SGT`
    + (old && !stale ? ` · data from ${esc(dataTime)}` : "")
    + (stale ? ` · <span class="stale" title="${esc(data.error || state.error || "")}">data may be stale</span>` : "");
}

/** Today's finished flights older than the grace period are tucked away. */
function isEarlier(f) {
  if (!isFinished(f)) return false;
  const ts = f.ats || f.ets;
  const m = ts ? sgtMinutes(ts.slice(0, 10), ts.slice(11, 16)) : sgtMinutes(f.d, f.st);
  return m !== null && m < Date.now() / 60e3 - EARLIER_GRACE_MIN;
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
    ? more + less + list.map(rowHTML).join("")
    : more + `<p class="empty">${state.q ? "No flights match your search." : "No flights."}</p>`;
}

function setPressed(sel, attr, val) {
  $$(sel).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === String(val))));
}

function bindBoard() {
  $$("[data-dir]").forEach((b) => b.addEventListener("click", () => {
    state.dir = b.dataset.dir; store.set("dir", state.dir); state.open.clear();
    setPressed("[data-dir]", "dir", state.dir); renderBoard();
  }));
  $$("[data-term]").forEach((b) => b.addEventListener("click", () => {
    state.term = b.dataset.term; store.set("term", state.term);
    setPressed("[data-term]", "term", state.term); renderBoard();
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
    const track = e.target.closest("[data-track]");
    if (track) { trackFlight(state.dir, track.dataset.track); return; }
    const row = e.target.closest(".flight");
    if (!row) return;
    const k = row.dataset.key;
    state.open.has(k) ? state.open.delete(k) : state.open.add(k);
    renderBoard();
  });
  setPressed("[data-dir]", "dir", state.dir);
  setPressed("[data-term]", "term", state.term);
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
  if (state.term !== "all" && state.term !== f.t) { state.term = "all"; store.set("term", state.term); }
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
  const map = L.map("map", { center: CHANGI, zoom: 10, zoomControl: true, attributionControl: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://adsb.lol">adsb.lol</a>',
  }).addTo(map);
  L.marker(CHANGI, {
    icon: L.divIcon({ className: "", html: '<div class="home-dot" title="Singapore Changi (SIN)"></div>', iconSize: [12, 12] }),
    interactive: false, keyboard: false,
  }).addTo(map);
  map.on("click", () => { if (tracker.selected || tracker.focus) select(null); });
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
  tracker.map = map;
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
async function loadTraffic({ fresh = false } = {}) {
  if (document.hidden) return;
  if (state.view === "board" && state.day !== 0) return; // live marks only apply to today
  const note = $("#map-note");
  try {
    const data = await getJSON("/api/traffic", { fresh });
    note.hidden = !data.stale;
    if (data.stale) note.textContent = "Positions delayed";
    tracker.traffic = data.ac || [];
    tracker.trafficAt = data.at || Date.now();
    applyTraffic(tracker.traffic);
  } catch (e) {
    note.hidden = false;
    note.textContent = "Live positions unavailable";
    if (tracker.focus) { tracker.focus.checked = true; tracker.focus.failed = true; renderCard(); }
  }
  computeLive();
}

function applyTraffic(list) {
  if (!tracker.map) return;
  const seen = new Set();
  for (const ac of list) {
    seen.add(ac.hex);
    const onBoard = Boolean(matchFlight(ac.cs));
    let entry = tracker.markers.get(ac.hex);
    if (!entry) {
      const marker = L.marker([ac.lat, ac.lon], {
        icon: planeIcon(ac, false, onBoard),
        keyboard: true,
        title: ac.cs || ac.hex,
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
    <p class="c-route"><small>${esc(f.fn)} · ${esc(f.an || f.al)} · ${time} ${esc(f.et || f.st)} · ${esc(f.status)}</small></p>`;
}

/** Friendly explanation when a tracked flight has no live position. */
function notLiveMessage(f) {
  const fn = `<strong>${esc(f.fn)}</strong>`;
  if (!f.checked) return `Looking for ${fn} on the map…`;
  if (f.failed) return `Live positions are unavailable right now, so ${fn} can't be shown. Try again in a minute.`;
  const s = `${f.raw} ${f.status}`.toLowerCase();
  if (/cancel/.test(s)) return `${fn} is cancelled.`;
  if (f.dir === "dep" && /depart/.test(s)) return `${fn} has departed and is now beyond the map's range.`;
  if (f.dir === "arr" && /landed|arrived/.test(s)) return `${fn} has landed and is no longer broadcasting its position.`;
  if (f.dir === "dep") {
    return `${fn} isn't airborne yet. It's due to depart at ${esc(f.et || f.st)}${f.gate ? ` from gate ${esc(f.gate)}` : ""}. It will appear here once it's airborne.`;
  }
  return `${fn} isn't within range of Changi yet. It's due to land at ${esc(f.et || f.st)} and will appear here once it's close.`;
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
    card.classList.add("show");
    card.setAttribute("aria-hidden", "false");
    return;
  }
  if (!entry) {
    tracker.cardFlight = null;
    card.classList.remove("show");
    card.setAttribute("aria-hidden", "true");
    return;
  }
  const { ac } = entry;
  const f = matchFlight(ac.cs);
  const km = haversineKm(CHANGI, [ac.lat, ac.lon]);
  const alt = ac.gnd ? "Ground" : ac.alt != null ? `${Math.round(ac.alt).toLocaleString("en-US")} ft` : "—";
  const spd = ac.gs != null ? `${Math.round(ac.gs)} kt` : "—";

  tracker.cardFlight = f;
  const route = f ? routeHTML(f) : "";
  $("#card-body").innerHTML = `
    <div class="c-head">
      <span class="c-cs">${esc(ac.cs || ac.hex.toUpperCase())}</span>
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
  card.classList.add("show");
  card.setAttribute("aria-hidden", "false");
}

function startTracker() {
  initMap();
  if (!tracker.map) { setTimeout(startTracker, 200); return; } // Leaflet still loading
  tracker.map.invalidateSize();
  if (!state.boards.has(sgtDate(0))) loadBoard(sgtDate(0), { quiet: true });
  loadTraffic();
  clearInterval(tracker.timer);
  tracker.timer = setInterval(loadTraffic, TRAFFIC_REFRESH_MS);
}
function stopTracker() { clearInterval(tracker.timer); tracker.timer = null; }

// ================================================================ refresh

let refreshing = null;

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
  if (manual) setSpinning(true);
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

// ================================================================ views

function show(view) {
  state.view = view;
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === view)));
  $("#view-board").hidden = view !== "board";
  $("#view-tracker").hidden = view !== "tracker";
  document.body.classList.toggle("tracking", view === "tracker");
  history.replaceState(null, "", view === "tracker" ? "#tracker" : location.pathname + location.search);
  if (view === "tracker") startTracker(); else stopTracker();
}

function init() {
  bindBoard();
  $$(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));
  $(".card-close").addEventListener("click", () => select(null));
  $("#card-body").addEventListener("click", (e) => {
    if (e.target.closest("[data-board]") && tracker.cardFlight) viewOnBoard(tracker.cardFlight);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (tracker.selected || tracker.focus)) select(null); });

  $("#refresh").addEventListener("click", () => refreshNow());

  loadBoard(currentDate());
  loadTraffic();
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
