# How the Urja Meter Ops portal works

> **STATUS: INCOMPLETE. Only the login page has been observed.**
> The environment in which this service was built could not log in to the portal (details below), so this document deliberately
> contains **no guesses presented as findings**. Section 1 is everything that was actually seen. Sections 2–4 say how to
> obtain the rest in one run and give the structure to fill in. Until they are filled in, `server/src/portal/urja.js` stays a stub
> and the service runs on synthetic fixture data (see README → Status).

## 1. Verified observations

Seen with a plain, unauthenticated page fetch of `https://urja-ops.flockenergy.tech` (early November 2026):

| Observation | Detail |
|---|---|
| Unauthenticated `GET /` | Redirects to `/login` (the fetch's final URL was `https://urja-ops.flockenergy.tech/login`). So the portal has route-based, session-protected pages. |
| Login page | Server-rendered HTML. Title "Urja Meter Ops — Sign in"; heading "Urja Meter Ops"; tagline "Distribution metering operations portal"; labelled **Email** and **Password** inputs and a **Sign in** control. |
| Rendering style | The login page's text is present in the HTML as served (no JavaScript needed to see the form), which suggests a classic server-rendered app. This is an inference from one page, not a finding about the data pages. |

**Not known yet** (despite what a typical legacy portal might do): the form's `action`/`method`/hidden fields (CSRF?), cookie names and lifetime,
what a logged-in page looks like, whether data comes as HTML tables or JSON, pagination, any export, session expiry behaviour, rate limits.

## 2. Why nothing more was observed

* The sandbox shell could not resolve the portal's hostname (outbound network was limited to a package-registry allowlist).
* The only tool that could reach the portal was a page fetcher: GET only, no cookies kept between calls, no form submission, so it cannot log in.
* I did not try to work around this (guessing endpoints, URL-embedded credentials, etc.): the brief asks for normal user-facing workflows only, and an unauthenticated guess would have produced nothing trustworthy anyway.

## 3. How to complete this document (≈10 minutes of runtime)

```bash
cp .env.example .env              # put PORTAL_USERNAME / PORTAL_PASSWORD from the brief in it (never commit it)
npm run install:all
npm run explore                   # → server/capture/SUMMARY.md, capture.json, pages/*
```

The explorer behaves like a polite logged-in user: it submits **only** the login form (the single non-GET request, which it lists in the report's
*audit* line), follows the portal's own same-origin links with a delay, samples at most 3 pages per URL "shape", refuses links that look destructive
(logout, delete, reset…), never submits any other form, lists (but does not fetch) endpoints that the portal's JavaScript calls with a mutating verb,
and GET-probes only the harmless-looking ones, capped. It never writes the password or cookie values to disk. `server/capture/` is git-ignored because
the raw pages may contain real data; copy sanitised excerpts into this file instead.

`SUMMARY.md` is organised so that each question below maps to a section of it.

## 4. Structure to fill in

### 4.1 Access and authentication
| Question | Source in `SUMMARY.md` | Finding |
|---|---|---|
| Login form: action, method, encoding, fields, hidden/CSRF fields | *Login* | |
| Cookie(s): names, `HttpOnly`/`Secure`/`SameSite`, lifetime (`Max-Age`/`Expires`) | *Login* | |
| Where does a successful login land? What does a failed one look like (message, status)? | *Login* | |
| What does an **expired/missing session** look like: `302 → /login`, `401`, an HTML page with 200? (the session client treats 401 and redirect-to-login as expiry) | probe a page with the cookie removed | |
| Session lifetime in practice; does activity extend it? | run `npm start` with `SOURCE_MODE=portal` for a long period and watch `/api/v1/health` (`relogins`, `loginFailures`) | |
| Logout behaviour | never called (deliberately) | |

### 4.2 Data and how to get it
| Dataset | Page/endpoint(s) | HTML or JSON? | Pagination (param names, page size, total count) | Filters/sort | Fields available | Notes |
|---|---|---|---|---|---|---|
| Meter list | | | | | | |
| Meter detail | | | | | | |
| Location (lat/lon, address?) | | | | | | |
| Network hierarchy | | | | | | |
| Consumption | | | | | | |

Questions to settle for **consumption** specifically, because the cache and aggregation depend on them:
granularity (15 min / hourly / daily?), unit, **interval energy vs cumulative register readings** (the service assumes interval kWh),
time zone of the timestamps, how far back history goes, whether the portal honours a date range or always returns a fixed window
(the adapter's `coverage` must say which window the portal answered for), and the maximum range per request.

### 4.3 Is there a bulk path?
Look at *Bulk / export / pagination hints* in the summary: CSV/JSON export links, a JSON endpoint behind the list page, a "show all" option.
If one exists, prefer it for `listMeters()` (one request instead of N pages) and record here how complete it is compared with the HTML tables.

### 4.4 Network hierarchy
How is the parent/child relationship represented (a parent id column, a path string, nested markup, separate pages per level)? What are the
levels called? Record the **inconsistencies actually observed** (orphans, duplicates, cycles, case/whitespace differences, ids that change
format between pages…) and confirm that `GET /api/v1/data-quality` reports them. The service already repairs and reports the generic cases
(see `server/src/domain/hierarchy.js`); anything new belongs in that file with a test.

### 4.5 Quirks and surprises
Rate limiting or throttling headers, slow endpoints, dates in mixed formats, numbers rendered as strings with separators, encoding problems,
trailing whitespace in ids, IDs that differ between list and detail pages, silent truncation, pages that return 200 with an error message…

## 5. How findings map into the code

Implement `listMeters()`, `listNodes()` and `getConsumption()` in `server/src/portal/urja.js` using `PortalSession.getJson / getHtml / getText`
(it handles login, session expiry, retries and politeness). Return the raw shapes documented in `server/src/portal/index.js`; normalisation,
hierarchy repair, caching and the API need no changes. Add parser tests from **sanitised** saved pages under `server/tests/fixtures/portal/`,
then switch `SOURCE_MODE=portal` and run `npm run test` plus a manual `POST /api/v1/sync?wait=true`.
