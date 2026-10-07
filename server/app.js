import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z, ZodError } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ROLES, STATUS, HttpError, assertTransition, expectedQty, trafficLight,
  approvalBlockers, wastagePct, fabricExpected,
} from './domain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const nowIso = () => new Date().toISOString();

// ---------- Input validation (strict: unknown keys such as verifierId/status are rejected) ----------
const posInt = (max) => z.number({ invalid_type_error: 'Must be a whole number', required_error: 'Required' })
  .int('Must be a whole number (no decimals)').positive('Must be greater than zero').max(max, `Must be ≤ ${max}`);
const yards = z.number({ invalid_type_error: 'Must be a number', required_error: 'Required' })
  .positive('Must be greater than zero').max(1_000_000, 'Too large')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Max 2 decimal places');

const schemas = {
  login: z.object({ email: z.string().trim().email(), password: z.string().min(1) }).strict(),
  createOrder: z.object({
    recipeId: posInt(1_000_000),
    targetQty: posInt(100_000),
    fabricRollId: z.string({ required_error: 'Required' }).trim().min(1, 'Required').max(50).regex(/^[A-Za-z0-9._-]+$/, 'Letters, numbers, . _ - only'),
    actualFabricYds: yards,
    submit: z.boolean().optional(),
  }).strict(),
  submit: z.object({ actualFabricYds: yards.optional() }).strict(),
  counts: z.object({
    counts: z.array(z.object({
      componentId: posInt(1_000_000),
      actualQty: z.number({ invalid_type_error: 'Must be a whole number', required_error: 'Required' })
        .int('Must be a whole number (no decimals)').min(0, 'Cannot be negative').max(10_000_000),
    }).strict()).min(1, 'No counts supplied').max(100),
  }).strict(),
  approve: z.object({}).strict(),
  reject: z.object({ note: z.string({ required_error: 'A rejection reason is required' }).trim().min(3, 'A rejection reason is required (min 3 characters)').max(1000) }).strict(),
  start: z.object({}).strict(),
};
const parse = (schema, body) => schema.parse(body ?? {});

// ---------- Data access helpers ----------
async function hydrate(q, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const items = (await q.query(
    `SELECT vi.order_id, vi.component_id, vi.expected_qty, vi.actual_qty, vi.status, rc.component_name, rc.pieces_per_garment
       FROM verification_items vi JOIN recipe_components rc ON rc.id = vi.component_id
      WHERE vi.order_id IN (${ph}) ORDER BY vi.id`, ids)).rows;
  const logs = (await q.query(
    `SELECT l.*, u.full_name AS verifier_name FROM verification_logs l JOIN users u ON u.id = l.verifier_id
      WHERE l.order_id IN (${ph}) ORDER BY l.id`, ids)).rows;
  return rows.map((r) => {
    const its = items.filter((i) => i.order_id === r.id).map((i) => ({
      componentId: i.component_id, name: i.component_name, piecesPerGarment: i.pieces_per_garment,
      expectedQty: i.expected_qty, actualQty: i.actual_qty, status: i.status,
      variance: i.actual_qty === null ? null : i.actual_qty - i.expected_qty,
    }));
    const hist = logs.filter((l) => l.order_id === r.id).map((l) => ({
      decision: l.decision, verifierId: l.verifier_id, verifierName: l.verifier_name, timestamp: l.timestamp,
      rejectionNote: l.rejection_note, wastagePct: l.wastage_pct,
      componentVariances: l.component_variances ? JSON.parse(l.component_variances) : null,
    }));
    const approval = hist.filter((h) => h.decision === 'APPROVED').pop() || null;
    return {
      id: r.id, orderNo: r.order_no, status: r.status,
      recipe: { id: r.recipe_id, code: r.recipe_code, name: r.recipe_name, category: r.category, stdFabricYards: r.std_fabric_yards, wastageCap: r.wastage_cap },
      targetQty: r.target_qty, fabricRollId: r.fabric_roll_id, actualFabricYds: r.actual_fabric_yds,
      expectedFabricYds: Math.round(fabricExpected(r.target_qty, r.std_fabric_yards) * 100) / 100,
      createdBy: { id: r.created_by, name: r.creator_name }, createdAt: r.created_at, updatedAt: r.updated_at,
      sewingStartedAt: r.sewing_started_at, sewingStartedBy: r.sewing_started_by_name || null,
      items: its,
      approval: approval && { ...approval, wastageExceedsCap: approval.wastagePct > r.wastage_cap },
      lastRejection: hist.filter((h) => h.decision === 'REJECTED').pop() || null,
      history: hist,
    };
  });
}

const ORDER_SELECT = `
SELECT o.*, r.recipe_code, r.name AS recipe_name, r.category, r.std_fabric_yards, r.wastage_cap,
       cu.full_name AS creator_name, su.full_name AS sewing_started_by_name
  FROM cutting_orders o
  JOIN recipes r ON r.id = o.recipe_id
  JOIN users cu ON cu.id = o.created_by
  LEFT JOIN users su ON su.id = o.sewing_started_by`;

async function fetchOrders(q, where = '', params = []) {
  const rows = (await q.query(`${ORDER_SELECT} ${where} ORDER BY o.id DESC`, params)).rows;
  return hydrate(q, rows);
}
async function mustFindOrder(q, id) {
  const rows = await fetchOrders(q, 'WHERE o.id = ?', [id]);
  if (!rows.length) throw new HttpError(404, 'Order not found');
  return rows[0];
}
const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid order id');
  return id;
};

// ---------- App factory ----------
export function createApp({ db, jwtSecret }) {
  if (!jwtSecret) throw new Error('JWT secret required');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  // Identity ALWAYS comes from the verified token + a fresh DB lookup, never from the request body.
  const authenticate = ah(async (req, _res, next) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
    let payload;
    try { payload = jwt.verify(h.slice(7), jwtSecret); } catch { throw new HttpError(401, 'Invalid or expired token'); }
    const u = (await db.query('SELECT id, email, role, full_name FROM users WHERE id = ?', [payload.sub])).rows[0];
    if (!u) throw new HttpError(401, 'Unknown user');
    req.user = u;
    next();
  });
  const requireRole = (...roles) => (req, _res, next) =>
    roles.includes(req.user.role) ? next() : next(new HttpError(403, `Forbidden: requires role ${roles.join(' or ')}`));

  const api = express.Router();

  // ----- Auth -----
  api.post('/auth/login', ah(async (req, res) => {
    const { email, password } = parse(schemas.login, req.body);
    const u = (await db.query('SELECT * FROM users WHERE lower(email) = lower(?)', [email])).rows[0];
    // Same message for unknown user / wrong password (no account enumeration).
    if (!u || !bcrypt.compareSync(password, u.password_hash)) throw new HttpError(401, 'Invalid email or password');
    const token = jwt.sign({ sub: u.id, role: u.role }, jwtSecret, { expiresIn: '8h' });
    res.json({ token, user: { id: u.id, email: u.email, role: u.role, fullName: u.full_name } });
  }));
  api.get('/auth/me', authenticate, (req, res) =>
    res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role, fullName: req.user.full_name } }));

  // ----- Recipes (cutting side only) -----
  api.get('/recipes', authenticate, requireRole(ROLES.SUP, ROLES.VER), ah(async (_req, res) => {
    const recipes = (await db.query('SELECT * FROM recipes ORDER BY id')).rows;
    const comps = (await db.query('SELECT * FROM recipe_components ORDER BY id')).rows;
    res.json({ recipes: recipes.map((r) => ({
      id: r.id, code: r.recipe_code, name: r.name, category: r.category, stdFabricYards: r.std_fabric_yards, wastageCap: r.wastage_cap,
      components: comps.filter((c) => c.recipe_id === r.id).map((c) => ({ id: c.id, name: c.component_name, piecesPerGarment: c.pieces_per_garment, imageUrl: c.image_url })),
    })) });
  }));

  // ----- Cutting orders -----
  api.post('/orders', authenticate, requireRole(ROLES.SUP), ah(async (req, res) => {
    const body = parse(schemas.createOrder, req.body);
    const created = await db.tx(async (t) => {
      const recipe = (await t.query('SELECT * FROM recipes WHERE id = ?', [body.recipeId])).rows[0];
      if (!recipe) throw new HttpError(422, 'Unknown recipe', { fieldErrors: { recipeId: ['Recipe not found'] } });
      const comps = (await t.query('SELECT * FROM recipe_components WHERE recipe_id = ? ORDER BY id', [recipe.id])).rows;
      const ts = nowIso();
      const orderNo = `CUT-${ts.slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const ins = await t.query(
        `INSERT INTO cutting_orders (order_no, recipe_id, target_qty, fabric_roll_id, actual_fabric_yds, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        [orderNo, recipe.id, body.targetQty, body.fabricRollId, body.actualFabricYds,
          body.submit ? STATUS.PENDING : STATUS.IN_PROGRESS, req.user.id, ts, ts]);
      const id = ins.rows[0].id;
      // Multiplier engine: expected = target quantity x pieces per garment (derived server-side only).
      for (const c of comps) {
        await t.query('INSERT INTO verification_items (order_id, component_id, expected_qty) VALUES (?,?,?)',
          [id, c.id, expectedQty(body.targetQty, c.pieces_per_garment)]);
      }
      return id;
    });
    res.status(201).json({ order: await mustFindOrder(db, created) });
  }));

  api.get('/orders', authenticate, requireRole(ROLES.SUP, ROLES.VER), ah(async (req, res) => {
    // Verifiers never see work still being cut.
    const orders = req.user.role === ROLES.VER
      ? await fetchOrders(db, 'WHERE o.status <> ?', [STATUS.IN_PROGRESS])
      : await fetchOrders(db);
    res.json({ orders });
  }));

  api.get('/orders/:id', authenticate, requireRole(ROLES.SUP, ROLES.VER), ah(async (req, res) => {
    const order = await mustFindOrder(db, idParam(req));
    if (req.user.role === ROLES.VER && order.status === STATUS.IN_PROGRESS) throw new HttpError(404, 'Order not found');
    res.json({ order });
  }));

  api.post('/orders/:id/submit', authenticate, requireRole(ROLES.SUP), ah(async (req, res) => {
    const body = parse(schemas.submit, req.body);
    const id = idParam(req);
    await db.tx(async (t) => {
      const order = await mustFindOrder(t, id);
      const tr = assertTransition('submit', req.user, order);
      const upd = await t.query(
        `UPDATE cutting_orders SET status = ?, updated_at = ?, actual_fabric_yds = COALESCE(?, actual_fabric_yds)
          WHERE id = ? AND status IN (?, ?)`,
        [tr.to, nowIso(), body.actualFabricYds ?? null, id, STATUS.IN_PROGRESS, STATUS.REJECTED]);
      if (upd.changes !== 1) throw new HttpError(409, 'Order state changed; reload and retry');
      // A re-cut batch must be physically re-counted from scratch.
      await t.query('UPDATE verification_items SET actual_qty = NULL, status = NULL WHERE order_id = ?', [id]);
    });
    res.json({ order: await mustFindOrder(db, id) });
  }));

  // ----- Verifier terminal -----
  api.put('/orders/:id/counts', authenticate, requireRole(ROLES.VER), ah(async (req, res) => {
    const { counts } = parse(schemas.counts, req.body);
    const id = idParam(req);
    await db.tx(async (t) => {
      const order = await mustFindOrder(t, id);
      if (order.status !== STATUS.PENDING) throw new HttpError(409, `Counts can only be recorded while PENDING_VERIFICATION (is ${order.status})`);
      const seen = new Set();
      for (const c of counts) {
        if (seen.has(c.componentId)) throw new HttpError(400, 'Duplicate componentId in counts');
        seen.add(c.componentId);
        const item = order.items.find((i) => i.componentId === c.componentId);
        if (!item) throw new HttpError(422, `Component ${c.componentId} does not belong to this order`);
        // Status is ALWAYS derived server-side from expected vs actual.
        await t.query('UPDATE verification_items SET actual_qty = ?, status = ? WHERE order_id = ? AND component_id = ?',
          [c.actualQty, trafficLight(item.expectedQty, c.actualQty), id, c.componentId]);
      }
      await t.query('UPDATE cutting_orders SET updated_at = ? WHERE id = ?', [nowIso(), id]);
    });
    res.json({ order: await mustFindOrder(db, id) });
  }));

  api.post('/orders/:id/approve', authenticate, requireRole(ROLES.VER), ah(async (req, res) => {
    parse(schemas.approve, req.body);
    const id = idParam(req);
    await db.tx(async (t) => {
      const order = await mustFindOrder(t, id);
      const tr = assertTransition('approve', req.user, order);
      // HARD STOP: recompute from raw counts; any RED / missing / uncounted component => 422.
      const blockers = approvalBlockers(order.items.map((i) => ({
        component_id: i.componentId, component_name: i.name, expected_qty: i.expectedQty, actual_qty: i.actualQty })));
      if (blockers.length) throw new HttpError(422, 'Approval blocked: component shortage or uncounted components', { blockers });
      const ts = nowIso();
      const wp = wastagePct(order.actualFabricYds, order.targetQty, order.recipe.stdFabricYards);
      const variances = order.items.map((i) => ({ componentId: i.componentId, name: i.name, expected: i.expectedQty, actual: i.actualQty, variance: i.actualQty - i.expectedQty, status: trafficLight(i.expectedQty, i.actualQty) }));
      const upd = await t.query('UPDATE cutting_orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?', [tr.to, ts, id, STATUS.PENDING]);
      if (upd.changes !== 1) throw new HttpError(409, 'Order state changed; reload and retry');
      await t.query(
        `INSERT INTO verification_logs (order_id, verifier_id, decision, rejection_note, wastage_pct, component_variances, timestamp)
         VALUES (?,?,?,?,?,?,?)`, [id, req.user.id, 'APPROVED', null, wp, JSON.stringify(variances), ts]);
    });
    res.json({ order: await mustFindOrder(db, id) });
  }));

  api.post('/orders/:id/reject', authenticate, requireRole(ROLES.VER), ah(async (req, res) => {
    const { note } = parse(schemas.reject, req.body);
    const id = idParam(req);
    await db.tx(async (t) => {
      const order = await mustFindOrder(t, id);
      const tr = assertTransition('reject', req.user, order);
      const ts = nowIso();
      const upd = await t.query('UPDATE cutting_orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?', [tr.to, ts, id, STATUS.PENDING]);
      if (upd.changes !== 1) throw new HttpError(409, 'Order state changed; reload and retry');
      const variances = order.items.map((i) => ({ componentId: i.componentId, name: i.name, expected: i.expectedQty, actual: i.actualQty, variance: i.actualQty === null ? null : i.actualQty - i.expectedQty, status: i.status }));
      await t.query(
        `INSERT INTO verification_logs (order_id, verifier_id, decision, rejection_note, wastage_pct, component_variances, timestamp)
         VALUES (?,?,?,?,?,?,?)`,
        [id, req.user.id, 'REJECTED', note, wastagePct(order.actualFabricYds, order.targetQty, order.recipe.stdFabricYards), JSON.stringify(variances), ts]);
    });
    res.json({ order: await mustFindOrder(db, id) });
  }));

  // ----- Sewing floor: query isolation is enforced in SQL; client params are never consulted -----
  api.get('/sewing/queue', authenticate, requireRole(ROLES.SEW), ah(async (_req, res) => {
    res.json({ orders: await fetchOrders(db, "WHERE o.status = 'VERIFIED'") });
  }));
  api.get('/sewing/active', authenticate, requireRole(ROLES.SEW), ah(async (_req, res) => {
    res.json({ orders: await fetchOrders(db, "WHERE o.status = 'SEWING_STARTED'") });
  }));
  api.get('/sewing/orders/:id', authenticate, requireRole(ROLES.SEW), ah(async (req, res) => {
    const rows = await fetchOrders(db, "WHERE o.id = ? AND o.status IN ('VERIFIED','SEWING_STARTED')", [idParam(req)]);
    if (!rows.length) throw new HttpError(404, 'Order not found');
    res.json({ order: rows[0] });
  }));
  api.post('/sewing/:id/start', authenticate, requireRole(ROLES.SEW), ah(async (req, res) => {
    parse(schemas.start, req.body);
    const id = idParam(req);
    await db.tx(async (t) => {
      const rows = await fetchOrders(t, "WHERE o.id = ? AND o.status IN ('VERIFIED','SEWING_STARTED')", [id]);
      if (!rows.length) throw new HttpError(404, 'Order not found');
      const tr = assertTransition('start', req.user, rows[0]);
      const ts = nowIso();
      const upd = await t.query('UPDATE cutting_orders SET status = ?, updated_at = ?, sewing_started_by = ?, sewing_started_at = ? WHERE id = ? AND status = ?',
        [tr.to, ts, req.user.id, ts, id, STATUS.VERIFIED]);
      if (upd.changes !== 1) throw new HttpError(409, 'Order state changed; reload and retry');
    });
    res.json({ order: (await fetchOrders(db, 'WHERE o.id = ?', [id]))[0] });
  }));

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  // ----- Static client (production build) -----
  const dist = path.join(here, '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // ----- Error handling -----
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: { fieldErrors: err.flatten().fieldErrors, formErrors: err.flatten().formErrors } });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
