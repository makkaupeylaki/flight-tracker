import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { refreshBoard } from "../src/index.js";
import { normalise, sgtToday, addDays, gateBase, effectiveTs } from "../src/changi.js";
import { makeKV, installCaches, makeCtx } from "./harness.js";
import { normaliseArea, normaliseCallsign, MAX_DIST_NM } from "../src/traffic.js";

installCaches();
const today = sgtToday();

function flight(fn, t, status = "Scheduled", date = today) {
  return {
    flight_number: fn, airline: fn.slice(0, 2), airline_details: { name: "Test Air", code: fn.slice(0, 2) },
    airport: "PVG", airport_details: { name: "Shanghai", code: "PVG", country_code: "CN" },
    terminal: t, scheduled_date: date, scheduled_time: "07:25",
    estimated_timestamp: `${date} 07:30`, actual_timestamp: null,
    display_gate: "C22", check_in_row: "3", display_belt: null, aircraft_type: "A359",
    flight_status: status, status_mapping: { listing_status_en: status, show_gate: true },
  };
}

function mockChangi(flights, { fail = false } = {}) {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (fail) return new Response("blocked", { status: 403 });
    const q = JSON.parse(init.body).query;
    assert.match(q, /prev: "true"/);
    return Response.json({ data: { getFlights: { next_token: null, flights } } });
  };
  return () => calls;
}

test("normalise maps fields and hides gate when show_gate is false", () => {
  const f = normalise({ ...flight("SQ828", "3"), status_mapping: { listing_status_en: null, show_gate: false } });
  assert.equal(f.fn, "SQ828");
  assert.equal(f.city, "Shanghai");
  assert.equal(f.et, "07:30");
  assert.equal(f.gate, null);
  assert.equal(f.status, "Scheduled");
});

test("gate change ignores the hold-room L/R suffix and unpublished gates", () => {
  assert.equal(gateBase("f56l"), "F56");
  assert.equal(gateBase("A1"), "A1");
  const base = flight("SQ944", "3");
  const moved = normalise({ ...base, display_gate: "F54", current_gate: "F54", previous_gate: "F41" });
  assert.equal(moved.gate_was, "F41");
  const side = normalise({ ...base, display_gate: "F56", current_gate: "F56L", previous_gate: "F56R" });
  assert.equal(side.gate_was, null, "F56R -> F56L is the same gate for passengers");
  const hidden = normalise({ ...base, current_gate: "F54", previous_gate: "F41", status_mapping: { show_gate: false } });
  assert.equal(hidden.gate, null);
  assert.equal(hidden.gate_was, null);
  const arr = normalise({ ...base, display_gate: "F36", current_gate: null, previous_gate: "F56L",
    pick_up_door: "1-6 (Basement 1)", nearest_carpark: "Car Park 2A" });
  assert.equal(arr.gate_was, "F56");
  assert.equal(arr.pick_door, "1-6 (Basement 1)");
  assert.equal(arr.carpark, "Car Park 2A");
  assert.equal(normalise({ ...base, drop_off_door: "3" }).drop_door, "3");
});

test("board is sorted by the displayed (estimated, else scheduled) time", async () => {
  const env = { BOARD_KV: makeKV() };
  const at = (fn, st, ets) => ({ ...flight(fn, "1"), scheduled_time: st, estimated_timestamp: ets });
  mockChangi([
    at("SQ1", "07:00", `${today} 09:10`),          // retimed later
    at("SQ2", "08:00", null),                      // no estimate
    at("SQ3", "08:30", `${today} 08:20`),          // a little early
    at("SQ4", "00:05", `${addDays(today, -1)} 23:50`), // estimate on the previous day
  ]);
  const { board } = await refreshBoard(env, today);
  assert.deepEqual(board.dep.map((f) => f.fn), ["SQ4", "SQ2", "SQ3", "SQ1"]);
  assert.equal(effectiveTs({ d: today, st: "08:00", ets: null }), `${today} 08:00`);
});

test("traffic areas are validated, rounded for caching and capped at 250 nm", () => {
  assert.deepEqual(normaliseArea(null, null, null), { lat: 1.4, lon: 104, dist: 50 });
  const a = normaliseArea("51.4712", "-0.4543", "40");
  assert.equal(a.lat, 51.5); assert.equal(a.lon, -0.5); assert.ok(a.dist >= 40);
  assert.equal(normaliseArea("10", "100", "900").dist, MAX_DIST_NM);
  assert.equal(normaliseArea("10", "370", "30").lon, 10, "panned past the antimeridian wraps");
  assert.throws(() => normaliseArea("95", "0", "10"), /lat/);
  assert.throws(() => normaliseArea("1", "1", "-5"), /dist/);
  assert.equal(normaliseCallsign(" sia 322 "), "SIA322");
  assert.throws(() => normaliseCallsign("SIA-322!"), /callsign/);
});

test("traffic: area and callsign lookups, fallback to airplanes.live, never KV", async () => {
  const env = { BOARD_KV: makeKV() };
  const ctx = makeCtx();
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("adsb.lol")) return new Response("rate limit exceeded", { status: 429 });
    return Response.json({ ac: [{ hex: "76cd7a", flight: "SIA322  ", lat: 30, lon: 60, alt_baro: 38000, gs: 520, track: 305 }] });
  };
  const area = await (await worker.fetch(new Request("https://x/api/traffic?lat=30.02&lon=60.01&dist=200"), env, ctx)).json();
  assert.equal(area.source, "airplanes.live");
  assert.equal(area.ac[0].cs, "SIA322");
  assert.deepEqual(area.area, { lat: 30, lon: 60, dist: 250 });
  assert.match(seen[0], /api\.adsb\.lol\/v2\/lat\/30\/lon\/60\/dist\/250/);
  assert.match(seen[1], /api\.airplanes\.live\/v2\/point\/30\/60\/250/);

  const cs = await (await worker.fetch(new Request("https://x/api/traffic?callsign=sia322"), env, ctx)).json();
  assert.equal(cs.callsign, "SIA322");
  assert.equal(cs.ac.length, 1);
  assert.ok(seen.some((u) => u.endsWith("/v2/callsign/SIA322")));

  assert.equal((await worker.fetch(new Request("https://x/api/traffic?lat=abc"), env, ctx)).status, 400);
  assert.equal(env.BOARD_KV.writes, 0, "traffic must never be written to KV");
});

test("addDays crosses month boundaries", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
});

test("cron writes KV only when the board changes; keeps T4 and unassigned, drops unknown terminals and other dates", async () => {
  const env = { BOARD_KV: makeKV() };
  const ctx = makeCtx();
  mockChangi([
    flight("SQ1", "1"), flight("SQ4", "4"), flight("SQ5", ""), flight("SQ6", "9"),
    flight("SQ9", "2", "Scheduled", addDays(today, -1)),
  ]);
  await worker.scheduled({}, env, ctx); await ctx.drain();
  const w1 = env.BOARD_KV.writes;
  await worker.scheduled({}, env, ctx); await ctx.drain();
  assert.equal(env.BOARD_KV.writes, w1, "unchanged data must not write");
  const board = JSON.parse(env.BOARD_KV.store.get(`board:${today}`));
  assert.deepEqual(board.dep.map((f) => f.fn), ["SQ1", "SQ4", "SQ5"]);
  assert.deepEqual(board.dep.map((f) => f.t), ["1", "4", null]);
  assert.ok(!("t_raw" in board.dep[0]));

  mockChangi([flight("SQ1", "1", "Boarding")]);
  await worker.scheduled({}, env, ctx); await ctx.drain();
  assert.equal(env.BOARD_KV.writes, w1 + 1);
});

test("on upstream failure /api/board serves stale KV data", async () => {
  const env = { BOARD_KV: makeKV() };
  const ctx = makeCtx();
  mockChangi([flight("SQ1", "1")]);
  await refreshBoard(env, today);
  mockChangi([], { fail: true });
  await worker.scheduled({}, env, ctx); await ctx.drain();
  assert.equal(JSON.parse(env.BOARD_KV.store.get("status")).ok, false);
  const today_ = await (await worker.fetch(new Request("https://x/api/board"), env, ctx)).json();
  assert.equal(today_.stale, true);
  assert.match(today_.error, /403/);
  assert.equal(today_.dep[0].fn, "SQ1");
  const res = await worker.fetch(new Request(`https://x/api/board?date=${addDays(today, 1)}`), env, ctx);
  assert.equal(res.status, 502, "no KV copy for tomorrow -> 502");
});

test("rejects bad dates and unknown paths", async () => {
  const env = { BOARD_KV: makeKV() };
  const ctx = makeCtx();
  assert.equal((await worker.fetch(new Request("https://x/api/board?date=nope"), env, ctx)).status, 400);
  assert.equal((await worker.fetch(new Request("https://x/nope"), env, ctx)).status, 404);
  const opt = await worker.fetch(new Request("https://x/api/board", { method: "OPTIONS" }), env, ctx);
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
});
