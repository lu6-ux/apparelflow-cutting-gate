# AI Optimization Report

> **DRAFT — the submitter must review and rewrite this in their own words.** This draft records what actually happened
> while this codebase was generated with Claude (Anthropic) in a single session. The assessment grades *your* candour and
> judgement, so before submitting: re-read every claim, delete anything you did not verify, and add your own findings
> from running and attacking the app (the checklist at the bottom lists good places to look).

## 1. Tools & Prompting
- **Claude (Anthropic)** — used for scaffolding the Express + React project, relational schema, state-machine design,
  Zod schemas, the Vitest/Supertest suite, CSS, README and this report.
- Prompting approach: the full challenge PDF was supplied; Claude first proposed an architecture (server-computed status,
  single transition function, transactional approval), then generated the code, ran the tests, and smoke-tested with curl.

## 2. Flawed / Broken AI Code (found while building and verifying)
1. **Test runner could not load the SQLite driver.** The first version imported `node:sqlite` with a normal `import`.
   Vitest's bundler tried to resolve it as a file (`Failed to load url sqlite`) and the whole API suite failed to load.
   Fixed by loading it with `process.getBuiltinModule('node:sqlite')`.
2. **Transaction interleaving risk in the synchronous SQLite driver.** The naive wrapper (`BEGIN … await fn … COMMIT`)
   lets another request's statements run *inside* an open transaction at any `await`, which would let a concurrent write be
   rolled back or committed by the wrong request. Added a transaction queue + "wait until idle" gate in `db.js`.
3. **Trust in a passing suite.** The first full run passed 31/31 immediately, which is not evidence the tests bite.
   A mutation check (changing the RED rule in `approvalBlockers` to never match) was run: 3 tests failed as expected,
   then the change was reverted. *(Add any further mutations you try yourself.)*
4. **Shell scaffolding bug:** `mkdir -p a/{b,c}` under `/bin/sh` created a literal `{server,client` directory — caught when
   the next `cd` failed; the stray directory was removed.

## 3. Human Refactoring
*(Write this section yourself. Suggested things to verify/refactor and record honestly:)*
- Checked that `<input type="number">` was **not** used (it hides invalid text, e.g. "1e5" or "-"), and validation is custom with inline messages.
- Confirmed UI traffic-light helper (`client/src/api.js → light`) is only for instant feedback; the server recomputes.
- Reviewed that numeric strings (`"10"`) are rejected by the API rather than coerced.
- Decided yards may have 2 decimals while all piece counts must be integers (physical reasoning).

## 4. Defensive Architecture
- **One transition table** (`TRANSITIONS` in `server/domain.js`) lists every legal action, source states and the single role
  allowed. `assertTransition()` → 403 wrong role / 409 wrong state. No route writes `status` from request data.
- **Hard stop re-derived at approval time** from raw `actual_qty` vs `expected_qty` inside the DB transaction (RED, uncounted,
  or zero components → 422). Stored item status is informational only.
- **Strict request schemas** reject unexpected keys (`verifierId`, `timestamp`, `status`) with 400; identity and time come from
  the verified JWT + a fresh user lookup and the server clock.
- **Optimistic state guard:** `UPDATE … WHERE id=? AND status=?` and a changed-rows check prevent double approval races.
- **Query isolation:** sewing endpoints hard-code `status = 'VERIFIED'` / `'SEWING_STARTED'` in SQL and never read query params;
  sewing users get 403 on cutting endpoints and 404 on unverified ids.
- **Immutable audit trail:** `verification_logs` is insert-only via DB triggers (SQLite + Postgres) and holds verifier id,
  timestamp, wastage % and a JSON snapshot of per-component variances.

## Checklist: things worth attacking yourself (and recording)
- Run the app and try white-on-white regressions in every browser/dark-mode setting.
- Replay approve/reject requests with Postman using the wrong role's token; try forged bodies.
- Double-click Approve; open two tabs as Verifier and approve in both.
- Try the Postgres path against a real Neon/Supabase database — only SQLite was exercised during generation.
