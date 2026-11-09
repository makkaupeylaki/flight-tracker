// Changi flight data source.
//
// ALL knowledge of the upstream API lives in this file. The rest of the Worker
// only calls `fetchBoard(date)` and gets back `{ dep: Flight[], arr: Flight[] }`
// in the normalised shape documented below. To switch to the official Changi
// developer-portal API later, rewrite this module and keep that contract.
//
// Upstream: the unofficial AppSync GraphQL endpoint used by changiairport.com.
// It can change or start blocking without notice.

const ENDPOINT = "https://ca-appsync.lz.changiairport.com/graphql";
const API_KEY = "da2-umfoldhfsnhh7e3zgbtyr3p6um";

// The WAF rejects requests that do not look like they come from the website.
const HEADERS = {
  "Content-Type": "application/json",
  "x-api-key": API_KEY,
  Origin: "https://www.changiairport.com",
  Referer: "https://www.changiairport.com/en/fly/flight-information/departures.html",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "application/json",
};

// Terminals this app shows. The feed labels them "1"-"4". Flights whose
// terminal isn't assigned yet (an empty string, common for later arrivals)
// are kept with t: null so they still appear under "All".
export const TERMINALS = ["1", "2", "3", "4"];

// The API caps page_size at ~512, and one day is ~500 flights per direction,
// so a full day is normally 1-2 pages. MAX_PAGES guards the 50-subrequest
// limit of the Workers free plan (2 directions x 6 pages = 12 max).
const PAGE_SIZE = "500";
const MAX_PAGES = 6;

// Changi's schema marks AirportDetail.name/code as non-nullable, but some
// airports (e.g. NLU) have no details. AppSync then returns the full list with
// that one flight's airport_details set to null *plus* an error. We keep the
// list (see gql) and fall back to the airport code for the city name.
const AIRPORT_FIELDS = "airport_details { name code country_code lat lng }";
const FIELDS = `
  flight_number airline
  airline_details { name logo_url code }
  airport
  ${AIRPORT_FIELDS}
  terminal scheduled_date scheduled_time
  estimated_timestamp actual_timestamp
  display_gate current_gate previous_gate check_in_row display_belt aircraft_type
  drop_off_door pick_up_door nearest_carpark
  flight_status
  status_mapping { listing_status_en belt_status_en show_gate }
`;

/** Add `days` to a yyyy-MM-dd string. */
export function addDays(date, days) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's date in Singapore (UTC+8, no DST). */
export function sgtToday(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}

function gqlString(s) {
  return JSON.stringify(String(s));
}

class ChangiError extends Error {
  constructor(message, errors = []) { super(message); this.errors = errors; }
}

/**
 * Run a query. GraphQL can return data *and* errors: one bad flight (e.g. a
 * missing airport name) must not sink the whole board, so partial data is
 * used and the errors are only logged. Throws only when there's no list.
 */
async function gql(query) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new ChangiError(`Changi API HTTP ${res.status}`);
  const body = await res.json();
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const data = body.data && body.data.getFlights;
  if (!data || !Array.isArray(data.flights)) {
    const msg = errors.length ? `Changi API error: ${errors[0].message || "unknown"}` : "Changi API: empty response";
    throw new ChangiError(msg, errors);
  }
  if (errors.length) {
    console.warn(`Changi API: using partial data, ${errors.length} field error(s), e.g. ${errors[0].message}`);
  }
  data.flights = data.flights.filter(Boolean); // a flight nulled by an error is skipped, not fatal
  return data;
}

const isAirportDetailError = (e) =>
  e instanceof ChangiError && e.errors.some((x) => /AirportDetail|airport_details/.test(`${x.message} ${(x.path || []).join("/")}`));

/**
 * All raw flights for one direction on one date.
 *
 * Quirk of the upstream API: `scheduled_date` is a cursor start, not a filter.
 * Without `prev` it pages forward from that date (from "now" if it is today)
 * across many days; with `prev: "true"` it returns the day *before*
 * `scheduled_date`. So the cheapest way to get the complete day D is
 * `scheduled_date = D + 1, prev = "true"`, then keep only flights dated D.
 */
async function fetchDirection(direction, date) {
  const flights = [];
  let token = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = [
      `direction: ${gqlString(direction)}`,
      `scheduled_date: ${gqlString(addDays(date, 1))}`,
      `prev: "true"`,
      `page_size: ${gqlString(PAGE_SIZE)}`,
    ];
    if (token) args.push(`next_token: ${gqlString(token)}`);
    const q = (fields) => `query { getFlights(${args.join(", ")}) { next_token flights { ${fields} } } }`;
    let data;
    try {
      data = await gql(q(FIELDS));
    } catch (e) {
      // If a bad airport record ever voids the whole page, retry without
      // airport details; cities then fall back to the airport code.
      if (!isAirportDetailError(e)) throw e;
      console.warn(`Changi API: retrying ${direction} ${date} page ${page + 1} without airport_details`);
      data = await gql(q(FIELDS.replace(AIRPORT_FIELDS, "")));
    }
    const batch = data.flights || [];
    flights.push(...batch);
    token = data.next_token;
    // Stop once we've paged past the requested day.
    if (!token || batch.length === 0) break;
    if (batch.every((f) => f.scheduled_date && f.scheduled_date < date)) break;
  }
  return flights.filter((f) => f.scheduled_date === date);
}

const nz = (v) => (v === null || v === undefined || v === "" ? null : String(v));

/** "2026-11-08 07:25" -> "07:25" (only when it is a full timestamp). */
function hhmm(ts) {
  if (!ts) return null;
  const m = String(ts).match(/(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

/**
 * The public gate number without the hold-room side: "F56L" -> "F56".
 * Changi's current_gate/previous_gate often carry an L/R suffix that the
 * displayed gate doesn't, and moving between F56R and F56L is not a change
 * passengers need to act on.
 */
export function gateBase(g) {
  const v = nz(g);
  return v ? v.trim().toUpperCase().replace(/(\d)[LR]$/, "$1") : null;
}

/**
 * Normalised flight (compact JSON for KV and the frontend):
 * {
 *   fn: "SQ828", al: "SQ", an: "Singapore Airlines", logo: url|null,
 *   ap: "PVG", city: "Shanghai", cc: "CN",
 *   t: "2"|null (null = terminal not assigned yet), d: "2026-11-08", st: "07:25",
 *   et: "07:40"|null, at: "07:38"|null, ets: "2026-11-08 07:40"|null, ats: ...,
 *   gate: "C22"|null, row: "3"|null, belt: "17"|null, ac: "A359"|null,
 *   gate_cur: "C22L"|null, gate_prev: "B9"|null,   (raw current_gate/previous_gate)
 *   gate_was: "B9"|null,  (previous gate when it really changed, L/R ignored)
 *   drop_door: "3"|null, pick_door: "1-6 (Basement 1)"|null, carpark: "Car Park 3A"|null,
 *   raw: "Departed", status: "Departed", belt_status: null
 * }
 * Gate fields stay null until Changi publishes the gate (status_mapping.show_gate).
 */
export function normalise(f) {
  const al = f.airline_details || {};
  const ap = f.airport_details || {};
  const sm = f.status_mapping || {};
  const showGate = sm.show_gate !== false;
  const gate = showGate ? nz(f.display_gate) : null;
  const gateCur = showGate ? nz(f.current_gate) : null;
  const gatePrev = showGate ? nz(f.previous_gate) : null;
  const nowBase = gateBase(gateCur || gate);
  const prevBase = gateBase(gatePrev);
  return {
    fn: nz(f.flight_number),
    al: nz(f.airline) || nz(al.code),
    an: nz(al.name),
    logo: nz(al.logo_url),
    ap: nz(f.airport) || nz(ap.code),
    city: nz(ap.name) || nz(f.airport),
    cc: nz(ap.country_code),
    t: TERMINALS.includes(String(f.terminal ?? "").trim()) ? String(f.terminal).trim() : null,
    t_raw: nz(f.terminal),
    d: nz(f.scheduled_date),
    st: nz(f.scheduled_time),
    et: hhmm(f.estimated_timestamp),
    at: hhmm(f.actual_timestamp),
    ets: nz(f.estimated_timestamp),
    ats: nz(f.actual_timestamp),
    gate,
    gate_cur: gateCur,
    gate_prev: gatePrev,
    gate_was: prevBase && nowBase && prevBase !== nowBase ? prevBase : null,
    drop_door: nz(f.drop_off_door),
    pick_door: nz(f.pick_up_door),
    carpark: nz(f.nearest_carpark),
    row: nz(f.check_in_row),
    belt: nz(f.display_belt),
    ac: nz(f.aircraft_type),
    raw: nz(f.flight_status),
    status: nz(sm.listing_status_en) || nz(f.flight_status) || "Scheduled",
    belt_status: nz(sm.belt_status_en),
  };
}

/**
 * The time the board shows for a flight, as a sortable "yyyy-MM-dd HH:mm":
 * the estimated time when Changi has one, else the scheduled time. Using the
 * full timestamp keeps cross-midnight estimates in the right place.
 */
export function effectiveTs(f) {
  return f.ets || `${f.d || ""} ${f.st || ""}`;
}

function prepare(raw) {
  const seen = new Set();
  return raw
    .map(normalise)
    // Keep T1-T4 and unassigned (t: null); drop anything else the feed invents.
    .filter((f) => f.fn && (f.t !== null || !f.t_raw))
    .map(({ t_raw, ...f }) => f)
    .filter((f) => {
      const k = `${f.fn}|${f.d}|${f.st}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => effectiveTs(a).localeCompare(effectiveTs(b)) || a.fn.localeCompare(b.fn));
}

/** Fetch the full board (terminals 1-4 plus unassigned) for a date. Throws on upstream failure. */
export async function fetchBoard(date) {
  const [dep, arr] = await Promise.all([fetchDirection("DEP", date), fetchDirection("ARR", date)]);
  if (dep.length === 0 && arr.length === 0) throw new Error("Changi API returned no flights");
  return { dep: prepare(dep), arr: prepare(arr) };
}
