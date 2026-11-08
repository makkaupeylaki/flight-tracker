// Live aircraft from community ADS-B feeds (no key needed).
//
// Two lookups:
//   - by area:     aircraft within `dist` nautical miles of (lat, lon), max 250 nm
//   - by callsign: one flight wherever it is, e.g. "SIA322"
// adsb.lol is tried first; on any failure (HTTP error, 429 rate limit, bad JSON)
// we fall back to airplanes.live. Nothing here touches KV: responses are cached
// only in memory / the edge cache by the caller, for a few seconds.

export const CHANGI = { lat: 1.3644, lon: 103.9915 };
export const DEFAULT_DIST_NM = 25;
export const MAX_DIST_NM = 250; // both providers cap the radius at 250 nm

// An honest User-Agent so providers can see who is calling.
const UA = "flightlah/1.0 (+https://flightlah.pages.dev)";

const SOURCES = [
  {
    name: "adsb.lol",
    area: ({ lat, lon, dist }) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
    callsign: (cs) => `https://api.adsb.lol/v2/callsign/${encodeURIComponent(cs)}`,
  },
  {
    name: "airplanes.live",
    area: ({ lat, lon, dist }) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${dist}`,
    callsign: (cs) => `https://api.airplanes.live/v2/callsign/${encodeURIComponent(cs)}`,
  },
];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function compact(a) {
  return {
    hex: a.hex,
    cs: typeof a.flight === "string" ? a.flight.trim() || null : null,
    reg: a.r || null,
    t: a.t || null,
    lat: a.lat,
    lon: a.lon,
    alt: a.alt_baro === "ground" ? 0 : num(a.alt_baro),
    gnd: a.alt_baro === "ground",
    gs: num(a.gs),
    trk: num(a.track) ?? num(a.true_heading),
  };
}

// Radius buckets and centre grid, so nearby requests share one cache entry and
// one upstream call. The grid step is small relative to the radius, and the
// radius is rounded up past the shift the grid introduces.
const DIST_BUCKETS = [25, 50, 100, 150, 200, 250];

const roundTo = (v, step) => Math.round(v / step) * step;

/**
 * Validate and normalise an area request. Returns { lat, lon, dist } with
 * rounded values, or throws an Error with a user-facing message.
 */
export function normaliseArea(latRaw, lonRaw, distRaw) {
  const has = (v) => v !== null && v !== undefined && v !== "";
  const lat = has(latRaw) ? Number(latRaw) : CHANGI.lat;
  let lon = has(lonRaw) ? Number(lonRaw) : CHANGI.lon;
  const want = has(distRaw) ? Number(distRaw) : DEFAULT_DIST_NM;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error("lat must be between -90 and 90");
  if (!Number.isFinite(lon)) throw new Error("lon must be a number");
  if (!Number.isFinite(want) || want <= 0) throw new Error("dist must be a positive number of nautical miles");
  lon = ((((lon + 180) % 360) + 360) % 360) - 180; // wrap panned maps back into -180..180

  const step = want <= 50 ? 0.1 : want <= 150 ? 0.25 : 0.5;
  const shiftNm = (step / 2) * 60 * Math.SQRT2; // worst-case centre shift from rounding
  const needed = Math.min(want + shiftNm, MAX_DIST_NM);
  const dist = DIST_BUCKETS.find((b) => b >= needed) || MAX_DIST_NM;
  const fix = (v) => Number(roundTo(v, step).toFixed(2));
  return { lat: Math.max(-90, Math.min(90, fix(lat))), lon: fix(lon), dist };
}

/** Normalise a callsign ("sia 322" -> "SIA322"), or throw. */
export function normaliseCallsign(raw) {
  const cs = String(raw || "").toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]{2,8}$/.test(cs)) throw new Error("callsign must be 2-8 letters or digits");
  return cs;
}

async function fromSources(urlFor) {
  const errors = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(urlFor(src), {
        headers: { Accept: "application/json", "User-Agent": UA },
        cf: { cacheTtl: 5 },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const list = body.ac || body.aircraft;
      if (!Array.isArray(list)) throw new Error("unexpected response");
      const ac = list
        .filter((a) => typeof a.lat === "number" && typeof a.lon === "number")
        .map(compact);
      return { source: src.name, ac };
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }
  throw new Error(errors.join("; ") || "No traffic source available");
}

/** Aircraft within an already-normalised area. Returns { source, ac }. */
export function fetchTraffic(area) {
  return fromSources((src) => src.area(area));
}

/** Aircraft currently using a callsign (usually 0 or 1). Returns { source, ac }. */
export function fetchCallsign(cs) {
  return fromSources((src) => src.callsign(cs));
}
