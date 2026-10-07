# ApparelFlow ERP — Cutting Operations & Gatekeeper Verification Terminal

Full-stack implementation of the Webtezza challenge: a server-enforced hard stop that prevents unverified,
mismatched or short cutting batches from ever reaching the Sewing Queue.

**Stack:** React 18 + Vite (client) · Node.js 22 + Express (API) · PostgreSQL in production / SQLite locally ·
JWT auth · Zod validation · Vitest + Supertest.

## Quick start (local)

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite`, so there are no native modules to compile).

```bash
npm install
npm run build        # builds the React client into client/dist
npm start            # http://localhost:3000  (creates ./apparelflow.db and seeds data)
npm test             # 31 automated tests
```
Dev mode with hot reload: `npm run dev:server` and, in another terminal, `npm run dev:client` (http://localhost:5173, proxies /api).

## Demo credentials (also shown on the login page, with a Role Switcher in the header)

| Role | Email | Password |
|---|---|---|
| Cutting Supervisor | supervisor@apparelflow.test | Supervisor@123 |
| Cutting Verifier | verifier@apparelflow.test | Verifier@123 |
| Sewing Supervisor | sewing@apparelflow.test | Sewing@123 |

## Deploy to the cloud (Render + Neon, both free tiers)

1. Create a Postgres database at neon.tech (or Supabase) and copy the connection string.
2. Push this repo to GitHub → Render → **New Web Service** (or use the included `render.yaml`).
   - Build: `npm install && npm run build` · Start: `npm start`
   - Env: `NODE_ENV=production`, `JWT_SECRET=<long random string>`, `DATABASE_URL=<neon string>`
3. On first boot the app creates the tables, triggers, and seeds users + the two recipes. Redeploys are idempotent.

Railway works identically. Do not deploy with SQLite on ephemeral disks — data would vanish on redeploy.

## Architecture

```
client/            React SPA (Login+demo panel, Supervisor / Verifier / Sewing views)
server/domain.js   PURE rules: traffic light, multiplier, wastage, approval blockers, transition table
server/app.js      Express routes: auth → role guard → Zod validation → transaction → domain rules
server/db.js       Async adapter over Postgres (pg) or SQLite; same SQL ("?" placeholders) for both
server/schema.js   DDL + audit-log immutability triggers
server/seed.js     Idempotent seed: 3 users, REC-BL01, REC-CT02
tests/             domain unit tests + API integration tests (in-memory SQLite)
```

### State machine
```
CUTTING_IN_PROGRESS ──submit──▶ PENDING_VERIFICATION ──approve (no RED, all counted)──▶ VERIFIED ──start──▶ SEWING_STARTED
                                   │      ▲
                                   └reject (note required)──▶ REJECTED ──re-submit (counts reset)──┘
```
All legal transitions live in one table (`TRANSITIONS` in `domain.js`). Each carries the only role allowed to perform it;
`assertTransition()` returns **403** for the wrong role and **409** for an illegal source state. Every write is
`UPDATE … WHERE id = ? AND status = <expected>` inside a transaction, so concurrent double-approvals cannot both win.

### Database schema
`users` → `cutting_orders.created_by`, `verification_logs.verifier_id`
`recipes` 1—N `recipe_components`; `recipes` 1—N `cutting_orders`
`cutting_orders` 1—N `verification_items` (one row per recipe component: `expected_qty`, `actual_qty`, `status`)
`cutting_orders` 1—N `verification_logs` (decision, verifier, timestamp, `wastage_pct`, `component_variances` JSON snapshot, `rejection_note`)

Extras beyond the minimum: `SEWING_STARTED` status plus `sewing_started_by/at`, CHECK constraints (positive quantities,
valid enums, non-empty rejection note), and **DB triggers that make `verification_logs` append-only** (UPDATE/DELETE raise).

### API

| Method & path | Role | Notes |
|---|---|---|
| POST `/api/auth/login`, GET `/api/auth/me` | any | JWT (8h). Identity is re-read from the DB on every request |
| GET `/api/recipes` | supervisor, verifier | recipes + components |
| POST `/api/orders` | supervisor | derives expected counts server-side; `submit:true` goes straight to PENDING_VERIFICATION |
| GET `/api/orders`, `/api/orders/:id` | supervisor (all), verifier (not IN_PROGRESS) | sewing gets 403 |
| POST `/api/orders/:id/submit` | supervisor | also re-submits REJECTED orders (counts reset) |
| PUT `/api/orders/:id/counts` | verifier | only while PENDING_VERIFICATION; status derived server-side |
| POST `/api/orders/:id/approve` | verifier | **422** if any component RED/uncounted |
| POST `/api/orders/:id/reject` | verifier | `{ "note": "…" }` mandatory (min 3 chars) |
| GET `/api/sewing/queue` | sewing | hard-coded `WHERE status = 'VERIFIED'`; query string ignored |
| GET `/api/sewing/active`, `/api/sewing/orders/:id` | sewing | VERIFIED/SEWING_STARTED only |
| POST `/api/sewing/:id/start` | sewing | VERIFIED → SEWING_STARTED |

### Security model
- Server-side RBAC on every route (`requireRole`); UI hiding is cosmetic only.
- Hard stop: approval recomputes from raw `actual_qty` vs `expected_qty` in the transaction — stored/client status is never trusted.
- Request bodies are **strict** Zod schemas: `verifierId`, `timestamp`, `status` etc. are rejected with 400. Verifier ID and timestamp come from the JWT/server clock.
- Inputs: quantities must be positive integers (JSON numbers — strings, negatives, decimals, empty payloads → 400). Fabric yards accept positive numbers with ≤ 2 decimals (yards are physically fractional).
- Sewing queries are isolated in SQL; sewing users cannot read `/api/orders` or fetch unverified orders by id.

### Fabric wastage
`wastage % = (actual yds − target_qty × std_yds_per_piece) ÷ (target_qty × std_yds_per_piece) × 100`, stored on the approval log (rounded to 2 dp).
A result above the recipe's `wastage_cap` is flagged ("Over cap") in the sewing view; it does not block approval, as the spec only gates on component shortages.

### Manual 5-minute audit path
1. Login page → click **Sign in as** Supervisor → *New cutting order* → Casual Blouse, 50, FAB-ROLL-882, 94.5 → Submit.
2. Switch role (header) to Verifier → open the batch → enter 99 for Sleeves: row turns red, **Approve** is disabled and the gate banner explains why. Try `curl` approve → 422.
3. Fix to 100 (all others at expected) → Approve. Switch to Sewing → batch appears with verifier name, timestamp, 5% wastage. Refresh: still there.

### Known limitations
- Tokens are kept in `localStorage` (simple, Postman-friendly). For a hardened deployment move to httpOnly cookies + CSRF protection.
- No login rate limiting. Single-tenant, no user management UI (users are seeded).
