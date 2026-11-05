# Urja Meter Ops API

A clean, documented, **read-only** REST API, plus a small web client, in front of the legacy *Urja Meter Ops* portal.
Built as a MERN app: **M**ongoDB · **E**xpress 5 · **R**eact 19 · **N**ode 20+.

```
legacy portal ──read-only HTTP (cookie session)──▶ source adapter ──▶ normalise ──▶ hierarchy ──▶ MongoDB ──▶ Express API ──▶ React client
                                                   (the only file      (clean +      (repair +      (index +    (Zod = validation   (overview, meters,
                                                    that knows the      flag bad      report         cache)      + OpenAPI + tests)  network, map)
                                                    portal)             data)         mess)
```

Where to find things: **[PROTOCOL.md](PROTOCOL.md)** (how the portal works) · **[openapi.json](openapi.json)** (the API; also served at `/openapi.json`, rendered at `/docs`) · **[REFLECTION.md](REFLECTION.md)**.

## Status — read this first

This repository is a working, tested service and UI **except for one piece: the adapter for the real portal**
(`server/src/portal/urja.js`), and therefore the substance of `PROTOCOL.md`.

* The environment this was built in could **not reach `urja-ops.flockenergy.tech`** (the host did not resolve from its shell, and its
  page-fetch tool cannot log in). So the portal's protocol was **not observed** and nothing in this repo pretends otherwise.
  What *was* observed: an unauthenticated `GET /` redirects to `/login`, a server-rendered page titled "Urja Meter Ops — Sign in" with Email and Password fields.
* Until the adapter exists, the default `SOURCE_MODE=fixture` serves **synthetic, deliberately messy demo data**. It is labelled everywhere:
  `meta.source` is `"fixture"` in every response, the UI shows a banner, and the server logs a warning at boot.
* **To finish it** (a short task once you can reach the portal):
  1. `cp .env.example .env` and fill in the credentials from the brief (they are intentionally not committed).
  2. `npm run install:all && npm run explore` — a read-only explorer (GET only, plus the login form) that logs in, follows the portal's own links, and writes `server/capture/SUMMARY.md`.
  3. Implement the three methods in `server/src/portal/urja.js` against the contract in `server/src/portal/index.js`, write up `PROTOCOL.md` from the capture, set `SOURCE_MODE=portal`.

| | Verified | How |
|---|---|---|
| Domain logic, session client, API, explorer, OpenAPI | yes | 48 automated tests (below) |
| MongoDB layer | **partly** | run against *FerretDB 1.24.2 on PostgreSQL 16*, a MongoDB-compatible server, because real `mongod` could not be installed in the build environment. Not run against real MongoDB. |
| React client | **partly** | production build; rendered in jsdom against the real API with every tab clicked through (no React warnings); chart and map SVGs rasterised and inspected. Not opened in a real browser. |
| `docker-compose.yml` | no | no Docker in the build environment (it only starts `mongo:7`) |
| **Anything against the real portal** | **no** | unreachable, see above |

## Quick start

Needs Node ≥ 20.19 and a MongoDB (6+; `docker compose up -d mongo` starts one).

```bash
npm run install:all          # server + client dependencies (lockfiles are committed)
npm run mongo                # docker compose up -d mongo   (or set MONGODB_URI to any MongoDB)
npm run build                # builds the React client; the API serves it from the same origin
npm start                    # http://localhost:3000   UI at /, Swagger UI at /docs, spec at /openapi.json
```

The first boot builds the local index (a few seconds). Configuration is by environment variables or a git-ignored `.env`; every option is documented in [`.env.example`](.env.example).
Development: `npm run dev:server` and `npm run dev:client` (UI on :5173, proxying the API). Tests: `npm test` (needs a MongoDB at `mongodb://127.0.0.1:27017`, or set `MONGODB_URI_TEST`; DB-dependent tests are *skipped with a message* if none is reachable).

### Sample requests

```bash
curl 'http://localhost:3000/api/v1/meters?status=active&attr.tariffCategory=commercial&limit=1'
```
```json
{
  "data": [{
    "id": "MTR-000006", "name": "Meter 000006", "serialNumber": "SN1517494", "type": "three-phase", "status": "active",
    "location": { "lat": 18.4950, "lon": 73.8244 }, "nodeId": "TR-111",
    "attributes": { "manufacturer": "Genus", "tariffCategory": "commercial", "sanctionedLoadKw": 3, "installedAt": "2024-02-03" },
    "dataQuality": []
  }],
  "page": { "limit": 1, "offset": 0, "total": 34 },
  "meta": { "source": "fixture", "syncedAt": "2026-11-03T22:32:10.235Z", "stale": false }
}
```

```bash
curl 'http://localhost:3000/api/v1/meters/MTR-000001/consumption?from=2026-10-30&to=2026-11-02&interval=day'   # twice
```
```jsonc
{ "data": { "meterId": "MTR-000001", "unit": "kWh", "interval": "day",
            "points": [{ "ts": "2026-10-30T00:00:00.000Z", "value": 6.961, "samples": 24 }, /* ... */],
            "summary": { "total": 21.168, "min": 6.961, "max": 7.189, "average": 7.056, "points": 3 } },
  "meta": { "source": "fixture", "servedFrom": "live", "cacheDecision": "not_cached", "ageSeconds": 0, "stale": false, "warning": null, /* ... */ } }
// second call:  "meta": { "source": "fixture", "servedFrom": "cache", "cacheDecision": "fresh", ... }   (the source was not touched)
```

Other examples: `/api/v1/meters/nearby?lat=18.52&lon=73.86&radiusM=500` · `/api/v1/meters?nodeId=FD-11` (everything below a feeder) ·
`/api/v1/hierarchy?depth=1` · `/api/v1/data-quality` · `POST /api/v1/sync?wait=true`.

## API at a glance

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/meters` | List/filter: `q`, `status`, `type`, `nodeId` (any depth), `hasLocation`, `attr.<name>=<value>` (any portal attribute), `sort`, `limit`/`offset` |
| `GET /api/v1/meters/{id}` | One meter + its path through the network (`hierarchyPath`) |
| `GET /api/v1/meters/{id}/consumption` | Time series, `interval=raw\|hour\|day`, read through a cache; `refresh=true` bypasses it |
| `GET /api/v1/meters/nearby` | "What's near this location?", nearest first, with `distanceM` |
| `GET /api/v1/hierarchy`, `/hierarchy/{nodeId}` | The network as a tree / one node with ancestors and children |
| `GET /api/v1/data-quality` | Every inconsistency found in the portal's data, by code |
| `POST /api/v1/sync` | Rebuild the local index from the portal (the only non-GET; it never writes to the portal) |
| `GET /api/v1/health` | Service + index + portal-session state; `?deep=true` also exercises the portal login |

Errors are always `{ "error": { "code", "message", "details?" } }`. `4xx` means your request is wrong; `502` means the portal failed or rejected us; `503 index_not_ready` (with `Retry-After`) means the first index build has not finished.

## Project layout

```
server/src/
  portal/    index.js (THE CONTRACT)  urja.js (real adapter: TODO)  fixture.js (synthetic)  session.js + cookieJar.js (resilient client)
  domain/    normalize.js  hierarchy.js  geo.js  freshness.js  aggregate.js        pure functions, no I/O
  db/        models.js (Mongoose)         services/  syncService.js  consumptionService.js  queries.js
  api/       schemas.js (Zod)  openapi.js  routes.js  errorHandler.js              app.js  index.js  config.js
server/scripts/   explore.mjs (read-only portal explorer)   generate-openapi.js
server/tests/     domain · session · api · explore · openapi
client/src/       App.jsx  components/{Overview,Meters,MeterDrawer,Network,MapView,ConsumptionChart}.jsx   (hand-rolled SVG charts, no chart library)
```

## Design decisions and trade-offs

* **One narrow seam to the portal.** Everything downstream consumes the three raw shapes in `portal/index.js`. A different portal protocol (HTML tables, JSON, CSV export) means rewriting one file. Trade-off: the contract is my guess at what the portal can supply (meters, hierarchy nodes, interval energy) until the explorer's findings confirm it.
* **A local MongoDB index instead of proxying every call.** The portal is slow, legacy and has no API; an index makes filtering across attributes, "everything under this feeder" and "near me" cheap, and makes the API fast and available when the portal is not. Trade-off: data is as fresh as the last sync (`INDEX_TTL_SEC`, default 6 h, `meta.syncedAt` / `meta.stale` say how fresh).
* **Meters and hierarchy are bulk-synced; consumption is lazy and cached.** Readings are only fetched for meters someone asks about. Freshness policy (`domain/freshness.js`): a window that touches "now" is trusted for 5 min, a closed past window for 24 h; the cache must also span the requested range; `refresh=true` always goes to the portal; if the portal fails and something is cached, it is served with `stale: true` and a warning instead of an error. Caveat: late-arriving readings inside an old window are not noticed until its TTL lapses.
* **Messy data is repaired deterministically and reported, never silently hidden and never fatal.** `domain/hierarchy.js` handles orphans (become roots), cycles (broken at the lowest id), self-parents, duplicate ids (first wins), sloppy references (`" tr-111 "` matches `TR-111`, but only when unambiguous), and unplaceable meters; `normalize.js` handles bad/missing coordinates, duplicate meters, inconsistent status casing. Everything surfaces in `/data-quality`, in each meter's `dataQuality`, and as warning badges in the UI. Invariant under test: *every meter is either under exactly one root or counted as unplaced*.
* **Read-only by construction.** The portal client exposes only GET helpers; the single POST is the login form; the explorer enforces the same and refuses destructive-looking URLs. The tests assert this.
* **Robust session handling** (`portal/session.js`): form login with hidden/CSRF fields echoed; on session expiry (401, or a redirect to the login page) it logs in **once** and replays, even when many requests fail at once (single-flight, plus a generation counter so a late failure cannot tear down a renewed session); failed logins trigger a cooldown (no lock-outs); transient failures (network, timeout, 408/425/429/500/502/503/504) are retried with backoff + jitter and `Retry-After`; bounded concurrency and a minimum request gap (politeness); cross-origin redirects are refused.
* **Zod schemas are the single source of truth** for query validation, `openapi.json` and the contract tests that parse real responses. A test fails if `openapi.json` is stale, invalid, or if a route exists that is not documented.
* **Safe filtering.** `attr.*` names are whitelisted to `[A-Za-z0-9_]` and values must be plain strings (no MongoDB operator can be injected); `q` is regex-escaped; empty parameters count as absent (so `?lat=` is an error, not latitude 0).
* **Dependency-light.** Own cookie jar, logger and SVG charts instead of libraries; `express`, `mongoose`, `zod`, `cheerio`, `swagger-ui-express`, `react` are the runtime dependencies.

## Assumptions

* Consumption values are **interval energy in kWh**. If the portal exposes cumulative register readings, the adapter must convert them to deltas.
* Buckets (`hour`/`day`) are **UTC**; a timestamp without an offset in a query is UTC. Utilities bill in local time: a `tz` parameter is the obvious extension.
* Meter and node ids are opaque strings, compared exactly (the *only* leniency is resolving parent references that differ by case/whitespace, flagged as `reference_mismatch`).
* Hierarchy = parent references (`id`, `parentId`); level names are passed through (`level`) rather than assumed. If the portal embeds the hierarchy in meter records, the adapter derives nodes from them (`listNodes()` may return `[]`).
* "Location" means a lat/lon pair; anything unusable is dropped and flagged rather than guessed (no swapped-coordinate "fixing").
* The portal login is a standard HTML form with a cookie session. If it turns out to be JSON/token based, `PortalSession.#login` is the one place to change.

## Intentionally skipped

Authentication/rate limiting on *my* API (it is a read-only internal-style service; add an API key or OIDC and `express-rate-limit` before exposing it) · containerising the app (only the database has a compose file) · delta/incremental sync · cursor pagination · time-zone-aware buckets · metrics/tracing · CI · map tiles (the map is a positions-only plot, so no third-party requests) · i18n/accessibility audit of the UI beyond basics · any write path to the portal (by design).

## Scale: where this starts to struggle, and what I'd change

| Area | Now | Struggles around | Change |
|---|---|---|---|
| Sync | pulls everything, builds the tree in memory, rewrites the index | ~10⁵–10⁶ meters (memory, runtime) | stream pages and upsert as they arrive; delta sync if the portal exposes `updated_at`; lease/lock so only one API instance syncs |
| Text search `q` | substring regex = collection scan | ~10⁵ meters | text/prefix index or Atlas Search |
| Pagination | `limit`/`offset` | very deep offsets | keyset (`_id > cursor`) |
| Nearby | bounding box on a `(lat, lon)` index + exact haversine in the app; no antimeridian wrap; scan capped at 20 000 | huge radii in dense areas, global data | `2dsphere` index + `$geoNear` (not used here because FerretDB, my test stand-in, lacks geo queries) |
| Readings | one document per reading (≈2 000/meter for 90 days hourly) | ~10⁷–10⁸ readings | bucket per meter-day, or a MongoDB time-series collection, plus a retention policy |
| Hierarchy | whole tree rebuilt per request | ~10⁵ nodes | cache by `syncedAt`, lazy-load subtrees (`/hierarchy/{id}` already exists) |

`WRITE_BATCH_SIZE` defaults to 25 because FerretDB hung on bulk updates above ~45 operations; real MongoDB accepts far larger batches, so raise it there.

## With more time

1. Finish the real adapter and `PROTOCOL.md` (the main gap). 2. Run the whole suite against real MongoDB and Docker, and open the UI in real browsers. 3. Replace the "last window" cache coverage with merged interval coverage. 4. Contract tests for the adapter from recorded (sanitised) portal pages. 5. Anomaly views in the UI (silent meters, flat-lining, spikes) built on the consumption endpoint. 6. Auth, rate limiting, CI.

## Testing

`npm test` runs **48 server tests** (`node:test`) and a **UI smoke test** (jsdom).

* `domain` (pure logic): hierarchy repair cases, normalisation, geo, freshness decisions, aggregation.
* `session` (against a local fake legacy portal with CSRF form, redirect- and 401-style expiry, 503 + `Retry-After`, hostile cross-origin redirect): login, read-only guarantee, re-login, **single re-login under concurrency**, retries, cooldown, cookie jar.
* `api` (real database + the fixture): each endpoint's contract (parsed with the same Zod schemas that generate the docs), filters cross-checked against brute force (including `nearby` vs a haversine scan), hostile input, cache behaviour (hit / forced / wider range / stale-if-error), pruning on re-sync, the "every meter accounted for exactly once" invariant.
* `explore`: against a fake portal with traps (logout / delete links, a mutating endpoint named in JS, cross-origin link): asserts it only sends GET plus the login POST, never touches those URLs, and never writes the password or cookie values to disk.
* `openapi`: committed file is current and valid OpenAPI 3.1; every registered route is documented.

Two of these tests were **rewritten after a mutation check** showed they passed without the code they claim to protect (the concurrent-re-login race); another bug (the explorer would have GET-probed a path the portal's JS uses with `DELETE`) was found by the trap test and fixed. See REFLECTION.md.

## How AI was used

The whole build was delegated to Claude (Anthropic) in a chat session with a code-execution sandbox: architecture, the portal-exploration attempt, all server/client/test/doc code. I treated its output as untrusted and validated it by running it: the test suites above, mutation checks, a real boot of the server over HTTP, and rasterising the SVG visuals to look at them. What it could **not** do is reach the portal, which is why the adapter and `PROTOCOL.md` are open items. Details in [REFLECTION.md](REFLECTION.md).
