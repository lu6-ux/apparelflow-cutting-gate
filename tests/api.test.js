import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { openDb } from '../server/db.js';
import { migrate } from '../server/schema.js';
import { seed, DEMO_USERS } from '../server/seed.js';
import { createApp } from '../server/app.js';

let db, app;
const tokens = {};
const auth = (role) => ({ Authorization: `Bearer ${tokens[role]}` });

beforeAll(async () => {
  db = openDb({ databaseUrl: null, sqlitePath: ':memory:' });
  await migrate(db);
  await seed(db);
  app = createApp({ db, jwtSecret: 'test-secret' });
  for (const u of DEMO_USERS) {
    const r = await request(app).post('/api/auth/login').send({ email: u.email, password: u.password });
    expect(r.status).toBe(200);
    tokens[u.role] = r.body.token;
  }
});
afterAll(() => db.close());

// 50 Casual Blouses => expected: front 50, back 50, sleeves 100, collar 50, cuffs 100
async function pendingOrder(overrides = {}) {
  const r = await request(app).post('/api/orders').set(auth('cutting_supervisor'))
    .send({ recipeId: 1, targetQty: 50, fabricRollId: 'FAB-ROLL-882', actualFabricYds: 94.5, submit: true, ...overrides });
  expect(r.status).toBe(201);
  return r.body.order;
}
const countAll = (order, fn = (i) => i.expectedQty) =>
  ({ counts: order.items.map((i) => ({ componentId: i.componentId, actualQty: fn(i) })) });

describe('Required test 1: all-GREEN order can be approved by a Verifier', () => {
  it('approves, records audit trail, and releases to the sewing queue', async () => {
    const o = await pendingOrder();
    expect(o.status).toBe('PENDING_VERIFICATION');
    expect(o.items.map((i) => i.expectedQty)).toEqual([50, 50, 100, 50, 100]);
    const c = await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o));
    expect(c.status).toBe(200);
    expect(c.body.order.items.every((i) => i.status === 'GREEN')).toBe(true);
    const a = await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({});
    expect(a.status).toBe(200);
    expect(a.body.order.status).toBe('VERIFIED');
    expect(a.body.order.approval.verifierName).toContain('Kasun');
    expect(a.body.order.approval.wastagePct).toBe(5);
    expect(a.body.order.approval.componentVariances).toHaveLength(5);
    const q = await request(app).get('/api/sewing/queue').set(auth('sewing_supervisor'));
    expect(q.body.orders.map((x) => x.id)).toContain(o.id);
  });
  it('YELLOW (excess) components may still be approved', async () => {
    const o = await pendingOrder();
    await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o, (i) => i.expectedQty + 2));
    const a = await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({});
    expect(a.status).toBe(200);
  });
});

describe('Required test 2: a RED (shortage) component blocks approval', () => {
  it('returns 422 and the order stays PENDING_VERIFICATION', async () => {
    const o = await pendingOrder();
    let first = true;
    await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier'))
      .send(countAll(o, (i) => { if (first) { first = false; return i.expectedQty - 1; } return i.expectedQty; }));
    const a = await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({});
    expect(a.status).toBe(422);
    expect(a.body.details.blockers[0].reason).toBe('SHORTAGE');
    const after = await request(app).get(`/api/orders/${o.id}`).set(auth('cutting_verifier'));
    expect(after.body.order.status).toBe('PENDING_VERIFICATION');
    const q = await request(app).get('/api/sewing/queue').set(auth('sewing_supervisor'));
    expect(q.body.orders.map((x) => x.id)).not.toContain(o.id);
  });
  it('uncounted components also block approval (422)', async () => {
    const o = await pendingOrder();
    const a = await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({});
    expect(a.status).toBe(422);
    expect(a.body.details.blockers.every((b) => b.reason === 'UNCOUNTED')).toBe(true);
  });
  it('a forged client "status": "GREEN" cannot bypass the gate (strict body + server-derived status)', async () => {
    const o = await pendingOrder();
    const forged = { counts: o.items.map((i) => ({ componentId: i.componentId, actualQty: 0, status: 'GREEN' })) };
    const c = await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(forged);
    expect(c.status).toBe(400);
    await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o, () => 0));
    const a = await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({});
    expect(a.status).toBe(422);
  });
});

describe('Required test 3: rejecting without a reason note is refused', () => {
  it('rejects empty / missing / whitespace-only notes with 400', async () => {
    const o = await pendingOrder();
    for (const body of [{}, { note: '' }, { note: '   ' }]) {
      const r = await request(app).post(`/api/orders/${o.id}/reject`).set(auth('cutting_verifier')).send(body);
      expect(r.status).toBe(400);
    }
    const ok = await request(app).post(`/api/orders/${o.id}/reject`).set(auth('cutting_verifier')).send({ note: 'Sleeve shortage, re-cut required' });
    expect(ok.status).toBe(200);
    expect(ok.body.order.status).toBe('REJECTED');
    expect(ok.body.order.lastRejection.rejectionNote).toMatch(/Sleeve/);
  });
  it('rejected order can be re-submitted and is re-counted from scratch', async () => {
    const o = await pendingOrder();
    await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o));
    await request(app).post(`/api/orders/${o.id}/reject`).set(auth('cutting_verifier')).send({ note: 'Defects found' });
    const r = await request(app).post(`/api/orders/${o.id}/submit`).set(auth('cutting_supervisor')).send({});
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe('PENDING_VERIFICATION');
    expect(r.body.order.items.every((i) => i.actualQty === null)).toBe(true);
  });
});

describe('Required test 4: non-verifier roles receive 403 on verification actions', () => {
  it.each(['cutting_supervisor', 'sewing_supervisor'])('%s cannot approve, reject or count', async (role) => {
    const o = await pendingOrder();
    await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o));
    expect((await request(app).post(`/api/orders/${o.id}/approve`).set(auth(role)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/orders/${o.id}/reject`).set(auth(role)).send({ note: 'x y z' })).status).toBe(403);
    expect((await request(app).put(`/api/orders/${o.id}/counts`).set(auth(role)).send(countAll(o))).status).toBe(403);
    const still = await request(app).get(`/api/orders/${o.id}`).set(auth('cutting_verifier'));
    expect(still.body.order.status).toBe('PENDING_VERIFICATION');
  });
  it('unauthenticated requests get 401; verifier cannot create orders; supervisor cannot reach sewing', async () => {
    expect((await request(app).post('/api/orders/1/approve').send({})).status).toBe(401);
    expect((await request(app).post('/api/orders').set(auth('cutting_verifier')).send({})).status).toBe(403);
    expect((await request(app).get('/api/sewing/queue').set(auth('cutting_supervisor'))).status).toBe(403);
    expect((await request(app).get('/api/sewing/queue').set(auth('cutting_verifier'))).status).toBe(403);
    expect((await request(app).get('/api/orders').set(auth('sewing_supervisor'))).status).toBe(403);
  });
});

describe('Required test 5: unapproved orders never appear in the Sewing Queue', () => {
  it('only VERIFIED orders are returned, whatever the query string says', async () => {
    const draft = await pendingOrder({ submit: false });
    const pending = await pendingOrder();
    const rejected = await pendingOrder();
    await request(app).post(`/api/orders/${rejected.id}/reject`).set(auth('cutting_verifier')).send({ note: 'Bad cut' });
    const verified = await pendingOrder();
    await request(app).put(`/api/orders/${verified.id}/counts`).set(auth('cutting_verifier')).send(countAll(verified));
    await request(app).post(`/api/orders/${verified.id}/approve`).set(auth('cutting_verifier')).send({});

    for (const qs of ['', '?status=PENDING_VERIFICATION', '?status=REJECTED&all=true', `?id=${pending.id}`, "?status=' OR 1=1 --"]) {
      const q = await request(app).get(`/api/sewing/queue${qs}`).set(auth('sewing_supervisor'));
      expect(q.status).toBe(200);
      expect(q.body.orders.every((o) => o.status === 'VERIFIED')).toBe(true);
      const ids = q.body.orders.map((o) => o.id);
      expect(ids).not.toContain(draft.id);
      expect(ids).not.toContain(pending.id);
      expect(ids).not.toContain(rejected.id);
      expect(ids).toContain(verified.id);
    }
    // direct object access to unverified orders is also hidden from sewing
    expect((await request(app).get(`/api/sewing/orders/${pending.id}`).set(auth('sewing_supervisor'))).status).toBe(404);
    expect((await request(app).get(`/api/orders/${pending.id}`).set(auth('sewing_supervisor'))).status).toBe(403);
    expect((await request(app).post(`/api/sewing/${pending.id}/start`).set(auth('sewing_supervisor')).send({})).status).toBe(404);
  });
  it('sewing supervisor can start a verified batch exactly once', async () => {
    const o = await pendingOrder();
    await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o));
    await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({});
    const s = await request(app).post(`/api/sewing/${o.id}/start`).set(auth('sewing_supervisor')).send({});
    expect(s.status).toBe(200);
    expect(s.body.order.status).toBe('SEWING_STARTED');
    expect((await request(app).post(`/api/sewing/${o.id}/start`).set(auth('sewing_supervisor')).send({})).status).toBe(409);
    const q = await request(app).get('/api/sewing/queue').set(auth('sewing_supervisor'));
    expect(q.body.orders.map((x) => x.id)).not.toContain(o.id);
  });
});

describe('Extra: tamper protection & input guards', () => {
  it('client-supplied verifier identity / timestamp / status are rejected; audit uses the session', async () => {
    const o = await pendingOrder();
    await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o));
    const bad = await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({ verifierId: 1, timestamp: '2000-01-01', status: 'VERIFIED' });
    expect(bad.status).toBe(400);
    const ok = await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({});
    expect(ok.body.order.approval.verifierName).toContain('Kasun');
    expect(new Date(ok.body.order.approval.timestamp).getFullYear()).toBeGreaterThanOrEqual(2024);
  });
  it('cannot approve twice, cannot approve a draft or rejected order (409)', async () => {
    const o = await pendingOrder();
    await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o));
    expect((await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({})).status).toBe(200);
    expect((await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({})).status).toBe(409);
    const draft = await pendingOrder({ submit: false });
    expect((await request(app).post(`/api/orders/${draft.id}/approve`).set(auth('cutting_verifier')).send({})).status).toBe(409);
  });
  it('counts cannot be edited after verification', async () => {
    const o = await pendingOrder();
    await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o));
    await request(app).post(`/api/orders/${o.id}/approve`).set(auth('cutting_verifier')).send({});
    const r = await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send(countAll(o, () => 1));
    expect(r.status).toBe(409);
  });
  it('audit log rows are immutable at the database level', async () => {
    await expect(db.query("UPDATE verification_logs SET wastage_pct = 0")).rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM verification_logs')).rejects.toThrow(/immutable/);
  });
  it.each([
    ['negative qty', { targetQty: -5 }], ['decimal qty', { targetQty: 10.5 }], ['string qty', { targetQty: '10' }],
    ['zero qty', { targetQty: 0 }], ['empty roll id', { fabricRollId: '' }], ['negative yards', { actualFabricYds: -1 }],
    ['non numeric yards', { actualFabricYds: 'abc' }], ['unknown key', { status: 'VERIFIED' }],
  ])('order creation rejects %s', async (_n, patch) => {
    const r = await request(app).post('/api/orders').set(auth('cutting_supervisor'))
      .send({ recipeId: 1, targetQty: 50, fabricRollId: 'FAB-1', actualFabricYds: 90, ...patch });
    expect(r.status).toBe(400);
  });
  it('rejects empty payloads and bad counts', async () => {
    expect((await request(app).post('/api/orders').set(auth('cutting_supervisor')).send({})).status).toBe(400);
    const o = await pendingOrder();
    for (const actualQty of [-1, 1.5, '5', null]) {
      const r = await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send({ counts: [{ componentId: o.items[0].componentId, actualQty }] });
      expect(r.status).toBe(400);
    }
    expect((await request(app).put(`/api/orders/${o.id}/counts`).set(auth('cutting_verifier')).send({ counts: [] })).status).toBe(400);
  });
  it('derives expected counts for the Crop Top recipe (2 side straps per garment)', async () => {
    const o = await pendingOrder({ recipeId: 2, targetQty: 40, actualFabricYds: 44 });
    expect(o.items.map((i) => i.expectedQty)).toEqual([40, 40, 40, 40, 80]);
    expect(o.recipe.code).toBe('REC-CT02');
  });
  it('bad login returns 401 with a generic message', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'verifier@apparelflow.test', password: 'nope' });
    expect(r.status).toBe(401);
  });
});
