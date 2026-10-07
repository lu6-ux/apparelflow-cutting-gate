// Pure business rules - no I/O. Unit-tested in tests/domain.test.js.
export const ROLES = { SUP: 'cutting_supervisor', VER: 'cutting_verifier', SEW: 'sewing_supervisor' };
export const STATUS = {
  IN_PROGRESS: 'CUTTING_IN_PROGRESS', PENDING: 'PENDING_VERIFICATION',
  REJECTED: 'REJECTED', VERIFIED: 'VERIFIED', SEWING: 'SEWING_STARTED',
};

// The ONLY legal transitions. Anything else is refused by assertTransition().
export const TRANSITIONS = {
  submit:  { from: [STATUS.IN_PROGRESS, STATUS.REJECTED], to: STATUS.PENDING, role: ROLES.SUP },
  approve: { from: [STATUS.PENDING], to: STATUS.VERIFIED, role: ROLES.VER },
  reject:  { from: [STATUS.PENDING], to: STATUS.REJECTED, role: ROLES.VER },
  start:   { from: [STATUS.VERIFIED], to: STATUS.SEWING, role: ROLES.SEW },
};

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export const expectedQty = (targetQty, piecesPerGarment) => targetQty * piecesPerGarment;

export function trafficLight(expected, actual) {
  if (actual === null || actual === undefined) return null;
  if (actual === expected) return 'GREEN';
  return actual > expected ? 'YELLOW' : 'RED';
}

export const fabricExpected = (targetQty, stdYards) => targetQty * stdYards;
export function wastagePct(actualYds, targetQty, stdYards) {
  const exp = fabricExpected(targetQty, stdYards);
  return Math.round(((actualYds - exp) / exp) * 100 * 100) / 100;
}

// Returns a list of blocking problems. Empty list => approval allowed.
export function approvalBlockers(items) {
  const problems = [];
  if (!items.length) problems.push({ reason: 'NO_COMPONENTS' });
  for (const it of items) {
    if (it.actual_qty === null || it.actual_qty === undefined) problems.push({ componentId: it.component_id, name: it.component_name, reason: 'UNCOUNTED' });
    else if (trafficLight(it.expected_qty, it.actual_qty) === 'RED') problems.push({ componentId: it.component_id, name: it.component_name, reason: 'SHORTAGE', expected: it.expected_qty, actual: it.actual_qty });
  }
  return problems;
}

export function assertTransition(action, user, order) {
  const t = TRANSITIONS[action];
  if (user.role !== t.role) throw new HttpError(403, `Role ${user.role} may not perform '${action}'`);
  if (!t.from.includes(order.status)) throw new HttpError(409, `Cannot ${action} an order in status ${order.status}`);
  return t;
}
