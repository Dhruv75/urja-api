# Reflection

> **DRAFT: edit before submitting.** This was written by the AI assistant that did the build, from what actually happened in it.
> It is accurate about the *build*, but only you can speak for *your* involvement. Everything marked **TODO(you)** needs your own
> words, and please delete any sentence you cannot stand behind in the follow-up conversation.

## What assumptions did you make?

The portal's data pages were never observed (see README → Status), so most assumptions are about what a portal like this can supply, and each is
isolated behind one contract (`server/src/portal/index.js`) so that being wrong costs one file:

* meters have an id, optional name/status/type/serial/coordinates and a parent reference; the hierarchy is expressed by parent references;
* consumption is **interval energy in kWh** (not cumulative register readings), bucketed in **UTC**;
* login is a standard HTML form with a cookie session; session expiry shows up as `401` or a redirect to the login page;
* the dataset is small enough (≲10⁵ meters) to sync wholesale and hold in memory while building the tree;
* data will be messy in the ways the brief hints at (orphans, duplicates, cycles, sloppy references, bad coordinates), so the pipeline repairs and *reports* instead of failing.

The full list, with reasons, is in the README ("Assumptions").

## Which part was the most difficult, and how did you get unstuck?

Two things, one solved and one not.

**Not solved: reaching the portal.** The build environment could not resolve the portal's hostname and its page-fetcher cannot log in, so the
central task, reverse-engineering the portal, could not be done there. I did not guess. I built the rest against a clean contract, wrote a read-only
**explorer** whose report answers the questions `PROTOCOL.md` asks, and documented exactly how to finish. *TODO(you): say whether and how you then
ran the explorer against the live portal, and what you found.*

**Solved: a database that hung.** The first re-sync (updating documents that already existed) hung forever against the MongoDB-compatible server used for
testing. I bisected it with timed probes: single updates were fast, bulk updates grew superlinearly and hung above ~45 operations; switching the
backend (SQLite → PostgreSQL) did not change that, which ruled out a storage quirk; a hung request also wedged the server until restart, which
initially made later experiments look like they were hanging for unrelated reasons, so I restarted it between trials. The fix was a configurable bulk batch size (default 25).
Real MongoDB has no such limit; I could not verify that here.

## If you had another day, what would you improve?

1. Finish `urja.js` and `PROTOCOL.md` from the explorer's capture; add adapter tests from sanitised recorded pages.
2. Run everything against real MongoDB and Docker, and the UI in real browsers.
3. Merge consumption cache coverage into intervals instead of "last fetched window", and detect late-arriving readings in old windows.
4. Delta sync (if the portal exposes a change marker) and a sync lease so several API instances don't all sync.
5. Anomaly views (silent meters, flat-lining, spikes) in the UI, built on the consumption endpoint.
6. Auth + rate limiting on the API, CI, and a time-zone parameter for daily buckets.

## What mistake did you make while solving this?

Three real ones, all caught by checking rather than by luck:

1. **A test that could not fail.** My first concurrency test ("many requests after session expiry share one login") passed. A mutation check, deliberately
   removing the fix, showed it *still* passed, so it proved nothing. The cause: the race needs one "session expired" answer to arrive *after* another request
   has already logged in again, and my fake portal never delayed any answer. I added a hook that delays one response and re-ran the mutation: it now fails
   without the fix (3 logins instead of 2) and passes with it.
2. **A safety bug in the explorer.** Its endpoint discovery also emitted every URL-looking string with an *unknown* method, so a path the portal's own JavaScript
   calls with `DELETE` would still have been fetched with `GET` as a "harmless probe". A trap in the explorer's test (a fake portal whose JS contains
   `axios.delete("/api/meters/1")`) exposed it. Fix: a path seen with any mutating verb is never probed; the test now asserts the `GET` never happens.
3. **A flaky UI test.** It failed intermittently because it asserted the "demo data" banner (a separate request in `App`) at the moment a different request's
   result appeared. I reproduced it six times before changing anything, then waited for the banner explicitly and removed `act()` (real network, real timers); it then passed
   8 consecutive runs.

## If you were reviewing your own submission, what would you criticise?

* **The headline deliverable is missing:** no real adapter, so `PROTOCOL.md` is a procedure, not a write-up. Everything else rests on the contract being right.
* **The "clean API" shape is partly a guess.** `attributes` is an open bag precisely because the portal's fields are unknown; once they are known several should be promoted to typed fields.
* **Verification gaps:** the database layer ran only on a MongoDB-compatible stand-in, the UI only in jsdom plus rasterised SVGs, Docker not at all.
* **Over-building risk:** a hierarchy repair engine, a staleness policy and a robust session client are built before seeing whether the real data needs them. I judged the brief's hints (messy hierarchy, long sessions, a misbehaving portal) to justify them, but that is a bet.
* The consumption cache's "coverage = last window" rule is simple but wasteful when users alternate windows; interval merging would fix it.
* No auth or rate limiting on the API itself.

## Which AI tools or agents did you use, what did you delegate, and how did you validate the output?

* **Tool:** Claude (Anthropic), in the Claude chat app with a code-execution sandbox (Node 22, npm, a MongoDB-compatible database it set up itself).
  *TODO(you): list anything else you used, and what you did by hand.*
* **Delegated:** essentially everything: architecture, the portal-exploration attempt, the server (Express, Mongoose, Zod/OpenAPI), the portal session client,
  the explorer, the React client, the tests, and these documents. The AI was told the stack (MERN).
* **Validation, all by running things rather than reading them:** 48 server tests + a UI smoke test; mutation checks on the tests that guard the subtle code
  (they found the problems above); filters cross-checked against brute-force computation; contract tests that parse responses with the schemas that generate
  the docs; a real boot of the server over HTTP (static client, SPA fallback, docs, graceful shutdown); the chart and map SVGs rasterised and looked at,
  which found a label collision and a misleading partial-day bar that I then fixed.
* **Not validated** (and not claimed): anything against the real portal, real MongoDB, Docker, a real browser. *TODO(you): what you personally reviewed and ran before submitting.*
