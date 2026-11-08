# Changi Board

A minimalist live flight board and aircraft tracker for Singapore Changi Airport (SIN), terminals 1–4. Flights whose terminal isn't assigned yet show as "TBC".
It runs entirely on the Cloudflare free tier:

```
Worker cron (*/10) ──► Changi GraphQL ──► normalise ──► hash ──► Workers KV (write only on change)
                                                                      │
Pages (web/) ──► GET /api/board    ◄──────────────────────────────────┘
             ──► GET /api/traffic  ──► adsb.lol (backup: airplanes.live), cached ~10 s, never in KV
```

| Path | What |
| --- | --- |
| `worker/src/changi.js` | **All** Changi data-source logic (endpoint, headers, query, paging, normalisation). Swap this one file for the official developer-portal API later. |
| `worker/src/traffic.js` | ADS-B proxy by map area or callsign (adsb.lol, falls back to airplanes.live). |
| `worker/src/index.js` | Cron handler, KV caching, `/api/board`, `/api/traffic`, CORS. |
| `worker/test/` | `npm test` — offline unit tests with a mocked upstream and in-memory KV. |
| `web/` | Static frontend (vanilla JS, Leaflet from cdnjs, OSM tiles). No build step. |
| `web/config.js` | The Worker URL the frontend calls. |

## API

- `GET /api/board` — today's board (SGT) from KV:
  `{ date, updatedAt, source, stale, error, dep: Flight[], arr: Flight[] }`.
  If the cron hasn't run yet it fetches live and seeds KV.
- `GET /api/board?date=yyyy-MM-dd` — another day (±7 days). Fetched live, cached ~5 min; falls back to KV.
- `GET /api/traffic` — aircraft near Changi (used for the board's live dots):
  `{ source, at, area, ac: [{ hex, cs, reg, t, lat, lon, alt, gnd, gs, trk }] }`.
- `GET /api/traffic?lat=&lon=&dist=` — aircraft around a map centre; `dist` in nautical miles, capped at 250.
  The centre and radius are rounded (grid of 0.1–0.5°, radius buckets 25–250 nm) so nearby requests share a cache entry.
- `GET /api/traffic?callsign=SIA322` — one flight wherever it is (`ac` is empty when no receiver sees it).

Traffic is fetched live (adsb.lol first; on any error, including its 429 rate limit, airplanes.live) and cached
only in Worker memory and via `Cache-Control: max-age=10`. It is never written to KV.

`Flight` fields: `fn` flight number, `al`/`an` airline code/name, `ap`/`city`/`cc` other airport,
`t` terminal, `d` date, `st`/`et`/`at` scheduled/estimated/actual HH:mm (`ets`/`ats` full timestamps),
`gate`, `row` (check-in), `belt`, `ac` aircraft type, `status` (friendly text), `raw` (raw status),
`gate_cur`/`gate_prev` (raw current/previous gate), `gate_was` (previous gate when it really changed, ignoring the
hold-room L/R suffix), `drop_door`, `pick_door`, `carpark`. Gate fields stay null until Changi publishes the gate.

## Deploy

Requires a Cloudflare account and `wrangler login` (or `CLOUDFLARE_API_TOKEN`).

```sh
cd worker
npm install

# 1. One-time: create the KV namespace and put its id in wrangler.toml
npx wrangler kv namespace create BOARD_KV
#    -> replace id = "000…000" under [[kv_namespaces]] with the printed id, commit it.

# 2. Deploy the Worker (also registers the */10 cron)
npx wrangler deploy
#    -> note the URL, e.g. https://changi-board.<subdomain>.workers.dev

# 3. Point the frontend at it: edit web/config.js
#    window.CHANGI_API = "https://changi-board.<subdomain>.workers.dev";

# 4. Deploy the frontend to Pages
cd ..
npx wrangler pages deploy web --project-name changi-board
#    (or connect the GitHub repo in the Pages dashboard: build command empty, output directory "web")

# 5. Optional: lock CORS to the Pages origin
#    set ALLOWED_ORIGINS = "https://changi-board.pages.dev" in worker/wrangler.toml, redeploy the Worker.
```

Check it: `curl https://changi-board.<subdomain>.workers.dev/api/board | head -c 400`.

## Local development

```sh
cd worker && npm install && npm run dev        # Worker on http://localhost:8787
# trigger the cron: curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"
npx serve ../web                               # frontend; on localhost it calls :8787 automatically
npm test                                       # unit tests
```

## Free-tier budget

- **Subrequests:** a full day is ~500 flights per direction; the API allows `page_size` up to ~512, so a cron run
  makes ~4 upstream calls (cap 12; the limit is 50).
- **KV writes (1,000/day):** the board is written only when its hash changes, plus a heartbeat write at most every
  30 min so "last updated" stays honest. Worst case 144/day, plus a few around midnight and on status changes.
- **KV reads (100,000/day):** `/api/board` responses are memoised per isolate and cached at the edge for 30 s.
- **Worker requests (100,000/day):** an open page auto-refreshes `/api/board` and `/api/traffic` every 2 min while
  visible (the Tracker tab also polls `/api/traffic` every 15 s), plus whatever the refresh button is tapped for.
  That's about 1 request/min per board viewer, so roughly 70 people watching all day before hitting the limit;
  static Pages assets don't count.

## Upstream quirks (Changi GraphQL)

- `scheduled_date` is a cursor start, not a filter. With `prev: "true"` it returns the day *before*, so the Worker
  asks for `scheduled_date = D+1, prev = "true"` to get the whole of day D in one or two pages.
- The WAF requires browser-like `Origin`, `Referer` and `User-Agent` headers.

## Caveats

- The Changi endpoint is **unofficial** and may change or start blocking without notice. On failure the Worker
  keeps serving the last KV copy and the board shows "data may be stale" next to "Last updated HH:MM SGT".
- adsb.lol and airplanes.live are community feeds; coverage and callsigns vary, and planes over oceans or remote
  areas often aren't seen ("Out of coverage"). Callsigns are matched to board flights through an ICAO→IATA airline
  map (SIA→SQ, TGW→TR, …), with a numeric-only fallback for unmapped carriers; the same map builds the callsign
  used to find a departed flight.
- adsb.lol rate-limits bursts (HTTP 429). airplanes.live may refuse requests (HTTP 403) from clients it doesn't
  know and asks developers to email contact@airplanes.live first, so the fallback may not work until you do.

Flight data: Changi Airport (changiairport.com). Aircraft positions: adsb.lol community ADS-B feed (backup: airplanes.live). Unofficial app.
