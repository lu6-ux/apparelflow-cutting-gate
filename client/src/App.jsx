import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, setToken, getToken, ApiError, light } from './api.js';

const DEMO = [
  { role: 'cutting_supervisor', label: 'Cutting Supervisor', email: 'supervisor@apparelflow.test', password: 'Supervisor@123', blurb: 'Creates cutting orders. Cannot verify or see the sewing queue.' },
  { role: 'cutting_verifier', label: 'Cutting Verifier', email: 'verifier@apparelflow.test', password: 'Verifier@123', blurb: 'Counts parts, approves or rejects. Cannot create orders.' },
  { role: 'sewing_supervisor', label: 'Sewing Supervisor', email: 'sewing@apparelflow.test', password: 'Sewing@123', blurb: 'Sees verified batches only and starts assembly.' },
];
const STATUS_LABEL = {
  CUTTING_IN_PROGRESS: 'Cutting in progress', PENDING_VERIFICATION: 'Pending verification',
  REJECTED: 'Rejected', VERIFIED: 'Verified', SEWING_STARTED: 'Sewing started',
};
const LIGHT_LABEL = { GREEN: 'Match', YELLOW: 'Excess', RED: 'Shortage' };
const LIGHT_ICON = { GREEN: '●', YELLOW: '▲', RED: '■' };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// ---------- small shared pieces ----------
function Status({ s }) { return <span className={`badge st-${s}`}>{STATUS_LABEL[s] || s}</span>; }
function Light({ s }) {
  if (!s) return <span className="light light-NONE">Not counted</span>;
  return <span className={`light light-${s}`}><span aria-hidden="true">{LIGHT_ICON[s]}</span> {LIGHT_LABEL[s]}</span>;
}
function Field({ label, error, hint, children, htmlFor }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="err" role="alert">{error}</div>}
    </div>
  );
}
function Modal({ title, onClose, children }) {
  useEffect(() => { const h = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}
function useLoader(fn, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => { try { setData(await fn()); setError(''); } catch (e) { setError(e.message); } }, deps); // eslint-disable-line
  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}
const intOk = (s) => /^\d+$/.test(s.trim());

// ---------- Login + header ----------
function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e, p) => {
    setBusy(true); setErr('');
    try { const r = await api('/auth/login', { method: 'POST', body: { email: e, password: p } }); setToken(r.token); onLogin(r.user); }
    catch (x) { setErr(x.status === 400 ? 'Enter a valid email and password.' : x.message); } finally { setBusy(false); }
  };
  return (
    <main className="login">
      <section className="login-card">
        <h1>ApparelFlow</h1>
        <p className="sub">Cutting Operations &amp; Gatekeeper Verification Terminal</p>
        <form onSubmit={(e) => { e.preventDefault(); go(email, password); }} noValidate>
          <Field label="Email" htmlFor="email"><input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@apparelflow.test" /></Field>
          <Field label="Password" htmlFor="pw"><input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {err && <div className="err" role="alert">{err}</div>}
          <button className="btn primary wide" disabled={busy}>Sign in</button>
        </form>
      </section>
      <section className="demo-panel" aria-label="Demo credentials">
        <h2>Demo credentials</h2>
        <p className="sub">One click signs in as each factory persona.</p>
        {DEMO.map((d) => (
          <div className="demo" key={d.role}>
            <div>
              <strong>{d.label}</strong>
              <div className="mono small">{d.email} / {d.password}</div>
              <div className="small muted">{d.blurb}</div>
            </div>
            <button className="btn" disabled={busy} onClick={() => go(d.email, d.password)}>Sign in as</button>
          </div>
        ))}
      </section>
    </main>
  );
}

function Header({ user, onSwitch, onLogout }) {
  return (
    <header className="top">
      <div className="brand"><b>ApparelFlow</b><span>Cutting Gate</span></div>
      <div className="who">
        <label htmlFor="switch" className="small">Role switcher</label>
        <select id="switch" value={user.role} onChange={(e) => onSwitch(DEMO.find((d) => d.role === e.target.value))}>
          {DEMO.map((d) => <option key={d.role} value={d.role}>{d.label}</option>)}
        </select>
        <span className="small muted">{user.fullName}</span>
        <button className="btn" onClick={onLogout}>Sign out</button>
      </div>
    </header>
  );
}

// ---------- Cutting Supervisor ----------
function NewOrderModal({ recipes, onClose, onCreated }) {
  const [f, setF] = useState({ recipeId: String(recipes[0]?.id ?? ''), targetQty: '', fabricRollId: '', yds: '' });
  const [errs, setErrs] = useState({});
  const [formErr, setFormErr] = useState('');
  const recipe = recipes.find((r) => String(r.id) === f.recipeId);
  const qty = intOk(f.targetQty) ? Number(f.targetQty) : null;

  const validate = () => {
    const e = {};
    if (!f.recipeId) e.recipeId = 'Choose a recipe';
    if (!f.targetQty.trim()) e.targetQty = 'Required';
    else if (!intOk(f.targetQty)) e.targetQty = 'Whole numbers only (no negatives, decimals or text)';
    else if (Number(f.targetQty) < 1) e.targetQty = 'Must be at least 1';
    if (!f.fabricRollId.trim()) e.fabricRollId = 'Required';
    else if (!/^[A-Za-z0-9._-]+$/.test(f.fabricRollId.trim())) e.fabricRollId = 'Letters, numbers, . _ - only';
    if (!f.yds.trim()) e.yds = 'Required';
    else if (!/^\d+(\.\d{1,2})?$/.test(f.yds.trim())) e.yds = 'Positive number, max 2 decimals';
    else if (Number(f.yds) <= 0) e.yds = 'Must be greater than zero';
    return e;
  };
  const submit = async (andSubmit) => {
    const e = validate(); setErrs(e); setFormErr('');
    if (Object.keys(e).length) return;
    try {
      await api('/orders', { method: 'POST', body: { recipeId: Number(f.recipeId), targetQty: Number(f.targetQty), fabricRollId: f.fabricRollId.trim(), actualFabricYds: Number(f.yds), submit: andSubmit } });
      onCreated();
    } catch (x) {
      if (x instanceof ApiError && x.details?.fieldErrors) {
        const m = { recipeId: 'recipeId', targetQty: 'targetQty', fabricRollId: 'fabricRollId', actualFabricYds: 'yds' };
        setErrs(Object.fromEntries(Object.entries(x.details.fieldErrors).map(([k, v]) => [m[k] || k, v[0]])));
      } else setFormErr(x.message);
    }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="New cutting order" onClose={onClose}>
      <div className="grid2">
        <Field label="Recipe" error={errs.recipeId} htmlFor="recipe">
          <select id="recipe" value={f.recipeId} onChange={set('recipeId')}>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.name}</option>)}
          </select>
        </Field>
        <Field label="Target batch quantity (garments)" error={errs.targetQty} htmlFor="qty">
          <input id="qty" inputMode="numeric" value={f.targetQty} onChange={set('targetQty')} placeholder="e.g. 50" aria-invalid={!!errs.targetQty} />
        </Field>
        <Field label="Fabric roll ID" error={errs.fabricRollId} htmlFor="roll">
          <input id="roll" value={f.fabricRollId} onChange={set('fabricRollId')} placeholder="e.g. FAB-ROLL-882" aria-invalid={!!errs.fabricRollId} />
        </Field>
        <Field label="Actual fabric used (yards)" error={errs.yds} htmlFor="yds" hint={recipe && qty ? `Standard allowance: ${(qty * recipe.stdFabricYards).toFixed(2)} yds (wastage cap ${recipe.wastageCap}%)` : undefined}>
          <input id="yds" inputMode="decimal" value={f.yds} onChange={set('yds')} placeholder="e.g. 94.5" aria-invalid={!!errs.yds} />
        </Field>
      </div>
      {recipe && (
        <table className="tbl compact">
          <caption>Expected component counts (derived: garments × pieces per garment)</caption>
          <thead><tr><th>Component</th><th className="num">Per garment</th><th className="num">Expected</th></tr></thead>
          <tbody>{recipe.components.map((c) => (
            <tr key={c.id}><td>{c.name}</td><td className="num">{c.piecesPerGarment}</td><td className="num mono">{qty ? qty * c.piecesPerGarment : '—'}</td></tr>))}</tbody>
        </table>
      )}
      {formErr && <div className="err" role="alert">{formErr}</div>}
      <div className="actions">
        <button className="btn" onClick={() => submit(false)}>Save as in-progress</button>
        <button className="btn primary" onClick={() => submit(true)}>Submit for verification</button>
      </div>
    </Modal>
  );
}

function SupervisorView() {
  const orders = useLoader(() => api('/orders'));
  const recipes = useLoader(() => api('/recipes'));
  const [open, setOpen] = useState(false);
  const [exp, setExp] = useState(null);
  const [msg, setMsg] = useState('');
  const submit = async (o) => {
    setMsg('');
    try { await api(`/orders/${o.id}/submit`, { method: 'POST', body: {} }); orders.reload(); } catch (e) { setMsg(e.message); }
  };
  const list = orders.data?.orders || [];
  return (
    <section>
      <div className="bar"><h2>Cutting orders</h2>
        <button className="btn primary" disabled={!recipes.data} onClick={() => setOpen(true)}>+ New cutting order</button></div>
      {(orders.error || msg) && <div className="err" role="alert">{orders.error || msg}</div>}
      <div className="scroll">
        <table className="tbl">
          <thead><tr><th>Order</th><th>Recipe</th><th className="num">Qty</th><th>Fabric roll</th><th className="num">Yards</th><th>Status</th><th>Created</th><th /></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan="8" className="muted">No orders yet. Create the first cutting order.</td></tr>}
            {list.map((o) => (
              <React.Fragment key={o.id}>
                <tr>
                  <td className="mono">{o.orderNo}</td><td>{o.recipe.name}</td><td className="num">{o.targetQty}</td>
                  <td className="mono">{o.fabricRollId}</td><td className="num">{o.actualFabricYds}</td>
                  <td><Status s={o.status} /></td><td className="small">{fmt(o.createdAt)}</td>
                  <td className="rowact">
                    <button className="btn" onClick={() => setExp(exp === o.id ? null : o.id)}>{exp === o.id ? 'Hide' : 'Details'}</button>
                    {(o.status === 'CUTTING_IN_PROGRESS' || o.status === 'REJECTED') && <button className="btn primary" onClick={() => submit(o)}>{o.status === 'REJECTED' ? 'Re-submit after re-cut' : 'Submit'}</button>}
                  </td>
                </tr>
                {o.status === 'REJECTED' && o.lastRejection && (
                  <tr className="note-row"><td colSpan="8"><strong>Rejected by {o.lastRejection.verifierName}:</strong> {o.lastRejection.rejectionNote}</td></tr>)}
                {exp === o.id && (
                  <tr><td colSpan="8">
                    <table className="tbl compact"><thead><tr><th>Component</th><th className="num">Expected</th><th className="num">Counted</th><th>Status</th></tr></thead>
                      <tbody>{o.items.map((i) => <tr key={i.componentId}><td>{i.name}</td><td className="num">{i.expectedQty}</td><td className="num">{i.actualQty ?? '—'}</td><td><Light s={i.status} /></td></tr>)}</tbody></table>
                  </td></tr>)}
              </React.Fragment>))}
          </tbody>
        </table>
      </div>
      {open && recipes.data && <NewOrderModal recipes={recipes.data.recipes} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); orders.reload(); }} />}
    </section>
  );
}

// ---------- Cutting Verifier ----------
function Terminal({ orderId, onChanged }) {
  const { data, error, reload } = useLoader(() => api(`/orders/${orderId}`), [orderId]);
  const [vals, setVals] = useState({});
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const order = data?.order;

  useEffect(() => {
    if (order) { setVals(Object.fromEntries(order.items.map((i) => [i.componentId, i.actualQty === null ? '' : String(i.actualQty)]))); setNote(''); setMsg(''); }
  }, [order?.id, order?.updatedAt]); // eslint-disable-line

  const rows = useMemo(() => (order?.items || []).map((i) => {
    const raw = (vals[i.componentId] ?? '').trim();
    const valid = raw === '' || intOk(raw);
    const actual = raw !== '' && valid ? Number(raw) : null;
    return { ...i, raw, valid, actual, live: light(i.expectedQty, actual) };
  }), [order, vals]);

  if (error) return <div className="err" role="alert">{error}</div>;
  if (!order) return <p className="muted">Loading…</p>;
  const pending = order.status === 'PENDING_VERIFICATION';
  const invalid = rows.some((r) => !r.valid);
  const uncounted = rows.filter((r) => r.raw === '' && r.valid).length;
  const reds = rows.filter((r) => r.live === 'RED');
  const blocked = invalid || uncounted > 0 || reds.length > 0;
  const payload = () => ({ counts: rows.map((r) => ({ componentId: r.componentId, actualQty: r.actual })) });

  const run = async (fn) => { setBusy(true); setMsg(''); try { await fn(); await reload(); onChanged(); } catch (e) { setMsg(e.message + (e.details?.blockers ? ` (${e.details.blockers.map((b) => `${b.name}: ${b.reason}`).join(', ')})` : '')); } finally { setBusy(false); } };
  const save = () => run(async () => { await api(`/orders/${order.id}/counts`, { method: 'PUT', body: payload() }); setMsg('Counts saved.'); });
  const approve = () => run(async () => {
    await api(`/orders/${order.id}/counts`, { method: 'PUT', body: payload() });
    await api(`/orders/${order.id}/approve`, { method: 'POST', body: {} });
  });
  const reject = () => run(async () => {
    if (note.trim().length < 3) throw new Error('A rejection reason is required (min 3 characters)');
    if (rows.every((r) => r.raw !== '' && r.valid)) await api(`/orders/${order.id}/counts`, { method: 'PUT', body: payload() });
    await api(`/orders/${order.id}/reject`, { method: 'POST', body: { note: note.trim() } });
  });

  return (
    <div className="terminal">
      <div className="bar"><h2>{order.orderNo} · {order.recipe.name}</h2><Status s={order.status} /></div>
      <p className="small muted">{order.targetQty} garments · roll <span className="mono">{order.fabricRollId}</span> · {order.actualFabricYds} yds used (std {order.expectedFabricYds} yds) · cut by {order.createdBy.name}</p>
      <table className="tbl">
        <thead><tr><th>Component</th><th className="num">Expected</th><th className="num">Actual count</th><th>Status</th><th className="num">Variance</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.componentId} className={r.live ? `row-${r.live}` : ''}>
              <td>{r.name}<div className="small muted">{r.piecesPerGarment} per garment</div></td>
              <td className="num mono">{r.expectedQty}</td>
              <td className="num">
                {pending ? (<>
                  <input className="count" inputMode="numeric" aria-label={`Actual count for ${r.name}`} aria-invalid={!r.valid} value={vals[r.componentId] ?? ''}
                    onChange={(e) => setVals({ ...vals, [r.componentId]: e.target.value })} placeholder="0" />
                  {!r.valid && <div className="err" role="alert">Whole numbers ≥ 0 only</div>}
                </>) : <span className="mono">{r.actualQty ?? '—'}</span>}
              </td>
              <td><Light s={pending ? r.live : r.status} /></td>
              <td className="num mono">{(pending ? r.actual : r.actualQty) === null ? '—' : ((pending ? r.actual : r.actualQty) - r.expectedQty > 0 ? '+' : '') + ((pending ? r.actual : r.actualQty) - r.expectedQty)}</td>
            </tr>))}
        </tbody>
      </table>

      {pending ? (<>
        <div className={`gate ${blocked ? 'gate-blocked' : 'gate-open'}`} role="status">
          {blocked
            ? `Approval blocked — ${reds.length ? `${reds.length} component(s) short (${reds.map((r) => r.name).join(', ')})` : invalid ? 'fix invalid counts' : `${uncounted} component(s) not yet counted`}. Only "Reject batch" is available${reds.length ? '' : ' until every component is counted'}.`
            : 'All components counted with no shortage. Batch may be approved.'}
        </div>
        <Field label="Rejection reason (mandatory to reject)" htmlFor="note">
          <textarea id="note" rows="3" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 4 sleeves short, fabric defect on roll edge" />
        </Field>
        {msg && <div className={msg === 'Counts saved.' ? 'ok' : 'err'} role="alert">{msg}</div>}
        <div className="actions">
          <button className="btn" disabled={busy || invalid} onClick={save}>Save counts</button>
          <button className="btn danger" disabled={busy || note.trim().length < 3} onClick={reject} title={note.trim().length < 3 ? 'Enter a rejection reason first' : ''}>Reject batch</button>
          <button className="btn success" disabled={busy || blocked} onClick={approve} title={blocked ? 'Blocked: shortage or uncounted components' : ''}>Approve batch</button>
        </div>
      </>) : (
        <div className="record">
          {order.approval && <p><strong>Approved</strong> by {order.approval.verifierName} on {fmt(order.approval.timestamp)} · fabric wastage {order.approval.wastagePct}%</p>}
          {order.status === 'REJECTED' && order.lastRejection && <p><strong>Rejected</strong> by {order.lastRejection.verifierName} on {fmt(order.lastRejection.timestamp)}: {order.lastRejection.rejectionNote}</p>}
        </div>)}
    </div>
  );
}

function VerifierView() {
  const orders = useLoader(() => api('/orders'));
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('PENDING');
  const list = (orders.data?.orders || []).filter((o) => (tab === 'PENDING' ? o.status === 'PENDING_VERIFICATION' : o.status !== 'PENDING_VERIFICATION'));
  return (
    <section className="split">
      <aside>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'PENDING'} className={tab === 'PENDING' ? 'on' : ''} onClick={() => { setTab('PENDING'); setSel(null); }}>Awaiting QC</button>
          <button role="tab" aria-selected={tab === 'DONE'} className={tab === 'DONE' ? 'on' : ''} onClick={() => { setTab('DONE'); setSel(null); }}>History</button>
        </div>
        {orders.error && <div className="err" role="alert">{orders.error}</div>}
        {list.length === 0 && <p className="muted">{tab === 'PENDING' ? 'No batches waiting at the QC station.' : 'No verified or rejected batches yet.'}</p>}
        {list.map((o) => (
          <button key={o.id} className={`qitem ${sel === o.id ? 'on' : ''}`} onClick={() => setSel(o.id)}>
            <span className="mono">{o.orderNo}</span><span>{o.recipe.name} × {o.targetQty}</span><Status s={o.status} />
          </button>))}
      </aside>
      <div>{sel ? <Terminal key={sel} orderId={sel} onChanged={orders.reload} /> : <p className="muted pad">Select a batch to open the verification terminal.</p>}</div>
    </section>
  );
}

// ---------- Sewing Supervisor ----------
function SewingView() {
  const queue = useLoader(() => api('/sewing/queue'));
  const active = useLoader(() => api('/sewing/active'));
  const [sel, setSel] = useState(null);
  const [msg, setMsg] = useState('');
  const all = [...(queue.data?.orders || []), ...(active.data?.orders || [])];
  const o = all.find((x) => x.id === sel);
  const start = async () => {
    setMsg('');
    try { await api(`/sewing/${o.id}/start`, { method: 'POST', body: {} }); queue.reload(); active.reload(); } catch (e) { setMsg(e.message); }
  };
  const Item = ({ x }) => (
    <button className={`qitem ${sel === x.id ? 'on' : ''}`} onClick={() => setSel(x.id)}>
      <span className="mono">{x.orderNo}</span><span>{x.recipe.name} × {x.targetQty}</span><Status s={x.status} />
    </button>);
  return (
    <section className="split">
      <aside>
        <h3>Sewing queue</h3>
        {(queue.error) && <div className="err" role="alert">{queue.error}</div>}
        {queue.data?.orders.length === 0 && <p className="muted">No verified batches waiting.</p>}
        {queue.data?.orders.map((x) => <Item key={x.id} x={x} />)}
        <h3>In assembly</h3>
        {active.data?.orders.length === 0 && <p className="muted">Nothing in assembly.</p>}
        {active.data?.orders.map((x) => <Item key={x.id} x={x} />)}
      </aside>
      <div>
        {!o ? <p className="muted pad">Select a verified batch to inspect piece counts and verifier notes.</p> : (
          <div className="terminal">
            <div className="bar"><h2>{o.orderNo} · {o.recipe.name}</h2><Status s={o.status} /></div>
            <p className="small muted">{o.targetQty} garments · roll <span className="mono">{o.fabricRollId}</span></p>
            <table className="tbl">
              <thead><tr><th>Component</th><th className="num">Expected</th><th className="num">Verified count</th><th>Status</th><th className="num">Variance</th></tr></thead>
              <tbody>{o.items.map((i) => <tr key={i.componentId} className={`row-${i.status}`}><td>{i.name}</td><td className="num mono">{i.expectedQty}</td><td className="num mono">{i.actualQty}</td><td><Light s={i.status} /></td><td className="num mono">{i.variance > 0 ? '+' : ''}{i.variance}</td></tr>)}</tbody>
            </table>
            <div className="record">
              <p><strong>Verified by</strong> {o.approval.verifierName} (user #{o.approval.verifierId}) · {fmt(o.approval.timestamp)}</p>
              <p><strong>Fabric wastage</strong> {o.approval.wastagePct}% ({o.actualFabricYds} yds used vs {o.expectedFabricYds} expected; cap {o.recipe.wastageCap}%)
                {o.approval.wastageExceedsCap && <span className="badge st-REJECTED"> Over cap</span>}</p>
              {o.sewingStartedAt && <p><strong>Sewing started</strong> by {o.sewingStartedBy} · {fmt(o.sewingStartedAt)}</p>}
            </div>
            {msg && <div className="err" role="alert">{msg}</div>}
            {o.status === 'VERIFIED' && <div className="actions"><button className="btn success" onClick={start}>Start sewing assembly</button></div>}
          </div>)}
      </div>
    </section>
  );
}

// ---------- Root ----------
export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    (async () => {
      if (getToken()) { try { setUser((await api('/auth/me')).user); } catch { setToken(null); } }
      setReady(true);
    })();
  }, []);
  const logout = () => { setToken(null); setUser(null); };
  const switchTo = async (d) => {
    const r = await api('/auth/login', { method: 'POST', body: { email: d.email, password: d.password } });
    setToken(r.token); setUser(r.user);
  };
  if (!ready) return null;
  if (!user) return <Login onLogin={setUser} />;
  return (
    <>
      <Header user={user} onSwitch={switchTo} onLogout={logout} />
      <main key={user.id} className="page">
        {user.role === 'cutting_supervisor' && <SupervisorView />}
        {user.role === 'cutting_verifier' && <VerifierView />}
        {user.role === 'sewing_supervisor' && <SewingView />}
      </main>
    </>
  );
}
