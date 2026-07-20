import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './style.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

// Each report a tenant can pull from SP-API, with a short ledger code and a
// human label. Order here is the order they render in the Sync Ledger.
const REPORTS = [
  { type: 'DIRECT_SP_API_SYNC', code: 'API', label: 'Orders & finance', hint: 'Orders, items and finance events' },
  { type: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', code: 'STL', label: 'Settlements', hint: 'Payout batches & fee lines' },
  { type: 'GET_SALES_AND_TRAFFIC_REPORT', code: 'S&T', label: 'Sales & traffic', hint: 'Sessions, units, buy box' },
  { type: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', code: 'INV', label: 'Inventory', hint: 'FBA fulfillable stock' },
  { type: 'GET_FBA_REIMBURSEMENTS_DATA', code: 'RMB', label: 'Reimbursements', hint: 'FBA loss & damage credits' },
  { type: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', code: 'RTN', label: 'Customer returns', hint: 'Return reasons & disposition' }
];
const COLORS = ['#c98a2c', '#1f8a85', '#12213a', '#7fb6b2'];

// Which report(s) power each sidebar page. Each page now syncs only what it
// needs instead of showing every report side-by-side everywhere.
// Dashboard is deliberately absent here — it's an overview page and no
// longer shows any sync controls at all. Every other sidebar page gets only
// the report(s) it actually depends on.
const VIEW_REPORT_TYPES = {
  sales: ['GET_SALES_AND_TRAFFIC_REPORT'],
  inventory: ['GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'],
  payouts: ['DIRECT_SP_API_SYNC', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'],
  brand: ['DIRECT_SP_API_SYNC'],
  health: ['GET_FBA_REIMBURSEMENTS_DATA', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'],
  reports: REPORTS.map(r => r.type)
};
const VIEW_LEDGER_COPY = {
  sales: { title: 'Sales & traffic sync', subtitle: 'Powers this page only' },
  inventory: { title: 'Inventory sync', subtitle: 'This page only' },
  payouts: { title: 'Payout sync', subtitle: 'Orders, finance and settlements' },
  brand: { title: 'Brand analytics sync', subtitle: 'Orders and item performance' },
  health: { title: 'Returns & reimbursements sync', subtitle: 'Powers this page only' },
  reports: { title: 'Sync ledger', subtitle: 'Pull one report at a time' }
};

function authHeaders() { const token = localStorage.getItem('token'); return token ? { authorization: `Bearer ${token}` } : {}; }
function jsonHeaders(options = {}) {
  return {
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...authHeaders(),
    ...(options.headers ?? {})
  };
}
async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, { ...options, headers: jsonHeaders(options) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Request failed');
  return res.json();
}
const ACCESS_TOKEN_CACHE_PREFIX = 'amazon_spapi_access_token:';
function readAmazonTokenCache(tenantId) { const cached = JSON.parse(localStorage.getItem(`${ACCESS_TOKEN_CACHE_PREFIX}${tenantId}`) ?? 'null'); return cached?.accessToken && cached?.expiresAt && Date.now() < cached.expiresAt - 60_000 ? cached : null; }
async function getAmazonAccessToken(tenantId) { const cached = readAmazonTokenCache(tenantId); if (cached) return cached; const fresh = await api(`/api/tenants/${tenantId}/amazon/access-token`); localStorage.setItem(`${ACCESS_TOKEN_CACHE_PREFIX}${tenantId}`, JSON.stringify(fresh)); return fresh; }
async function beginAmazonAuthorization(tenantId) { const { url } = await api(`/api/auth/amazon/start?tenantId=${tenantId}&json=1`); window.location.assign(url); }

function Button({ className = '', variant = 'primary', ...props }) { return <button {...props} className={`btn btn-${variant} ${className}`} />; }
function Input(props) { return <input {...props} className="input" />; }
function Card({ children, className = '' }) { return <section className={`card ${className}`}>{children}</section>; }
function Empty({ text }) { return <div className="empty-state">{text}</div>; }
function formatCurrency(value) { return `₹${Number(value ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
function formatNumber(value) { return Number(value ?? 0).toLocaleString('en-IN'); }
function trendHint(value) { return value ? <span className={`trend ${String(value).startsWith('-') ? 'down' : ''}`}>{value}</span> : null; }
function timeAgo(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Login only — account creation is admin-only now (see AdminDashboard's
// "Create seller account" card), so there is no self-serve signup here.
function Login({ setSession }) {
  const [form, setForm] = useState({ email: 'admin@reconcile.local', password: 'Admin12345!' });
  const [error, setError] = useState('');
  const navigate = useNavigate();
  async function submit(event) {
    event.preventDefault(); setError('');
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(form) });
      localStorage.setItem('token', data.token); setSession(data.user);
      navigate(data.user.role === 'admin' ? '/admin' : `/seller?tenantId=${data.user.tenantId}`);
    } catch (e) { setError(e.message); }
  }
  return <main className="login-shell">
    <section className="login-hero">
      <div className="brand-mark">W</div>
      <p className="eyebrow">Ledger 01 — Seller Reconciliation</p>
      <h1>Every rupee Amazon touches, reconciled in one command center.</h1>
      <p>Connect Seller Central, pull SP-API orders and reports on your own schedule, and track payouts, sales, inventory and account health from a single secure cockpit.</p>
      <div className="hero-ledger">
        <div><span>01</span>Settlements</div>
        <div><span>02</span>Sales &amp; traffic</div>
        <div><span>03</span>Reimbursements</div>
        <div><span>04</span>Customer returns</div>
      </div>
    </section>
    <Card className="login-card">
      <h2 style={{ marginBottom: 18 }}>Seller login</h2>
      <form onSubmit={submit} className="form-stack">
        <Input placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
        <Input type="password" placeholder="Password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
        <Button>Login</Button>
        {error && <p className="alert error">{error}</p>}
        <p className="muted small">Don't have an account? Ask your admin to create one for you.</p>
        <p className="muted small">Default dev admin: admin@reconcile.local / Admin12345!</p>
      </form>
    </Card>
  </main>;
}

// ---------- Date range picker ----------
// Replaces the static "Last 30 Days" label with an actual calendar: presets
// on the left, click-to-select custom range on the right. The chosen range
// is shared via context so panel subtitles that used to hardcode
// "Last 30 Days" now reflect whatever the user picked.
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function formatShort(d) { return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }); }
function formatRangeLabel(start, end) {
  const startStr = formatShort(start);
  const endStr = start.getFullYear() === end.getFullYear() ? formatShort(end) : end.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${startStr} – ${endStr}, ${end.getFullYear()}`;
}
function buildMonthGrid(viewDate) {
  const year = viewDate.getFullYear(), month = viewDate.getMonth();
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array(startWeekday).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  return cells;
}
const DATE_PRESETS = [
  { label: 'Today', range: () => { const t = startOfDay(new Date()); return [t, t]; } },
  { label: 'Last 7 Days', range: () => { const t = startOfDay(new Date()); return [addDays(t, -6), t]; } },
  { label: 'Last 30 Days', range: () => { const t = startOfDay(new Date()); return [addDays(t, -29), t]; } },
  { label: 'Last 90 Days', range: () => { const t = startOfDay(new Date()); return [addDays(t, -89), t]; } },
  { label: 'This Month', range: () => { const t = new Date(); return [new Date(t.getFullYear(), t.getMonth(), 1), startOfDay(t)]; } },
  { label: 'Last Month', range: () => { const t = new Date(); return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)]; } }
];
function defaultDateRange() { const end = startOfDay(new Date()); return { label: 'Last 30 Days', start: addDays(end, -29), end }; }
const DateRangeContext = createContext({ range: defaultDateRange(), setRange: () => {} });

function DateRangePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => new Date(value.end.getFullYear(), value.end.getMonth(), 1));
  const [pending, setPending] = useState({ start: value.start, end: value.end });
  const [selecting, setSelecting] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e) { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  function togglePicker() {
    setPending({ start: value.start, end: value.end });
    setViewMonth(new Date(value.end.getFullYear(), value.end.getMonth(), 1));
    setSelecting(false);
    setOpen(o => !o);
  }
  function pickDay(day) {
    if (!day) return;
    if (!selecting) { setPending({ start: day, end: day }); setSelecting(true); }
    else { setPending(day < pending.start ? { start: day, end: pending.start } : { start: pending.start, end: day }); setSelecting(false); }
  }
  function applyPreset(preset) { const [start, end] = preset.range(); onChange({ label: preset.label, start, end }); setOpen(false); }
  function applyCustom() { onChange({ label: formatRangeLabel(pending.start, pending.end), start: pending.start, end: pending.end }); setOpen(false); }

  const cells = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);
  const today = startOfDay(new Date()).getTime();

  return (
    <div className="date-range-picker" ref={rootRef}>
      <button type="button" className="date-range-trigger" onClick={togglePicker}>
        <span className="date-range-icon">📅</span>{value.label}
      </button>
      {open && (
        <div className="date-range-panel">
          <div className="date-range-presets">
            {DATE_PRESETS.map(p => <button type="button" key={p.label} className={p.label === value.label ? 'active' : ''} onClick={() => applyPreset(p)}>{p.label}</button>)}
          </div>
          <div className="date-range-calendar">
            <div className="calendar-nav">
              <button type="button" onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>‹</button>
              <b>{viewMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</b>
              <button type="button" onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>›</button>
            </div>
            <div className="calendar-weekdays">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => <span key={i}>{w}</span>)}</div>
            <div className="calendar-grid">
              {cells.map((day, i) => {
                if (!day) return <span key={i} className="calendar-cell empty" />;
                const t = day.getTime();
                const inRange = t >= pending.start.getTime() && t <= pending.end.getTime();
                const isEndpoint = t === pending.start.getTime() || t === pending.end.getTime();
                return <button type="button" key={i} disabled={t > today} className={`calendar-cell ${inRange ? 'in-range' : ''} ${isEndpoint ? 'endpoint' : ''}`} onClick={() => pickDay(day)}>{day.getDate()}</button>;
              })}
            </div>
            <div className="calendar-footer">
              <span className="muted small">{formatRangeLabel(pending.start, pending.end)}</span>
              <div className="calendar-actions">
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={applyCustom}>Apply</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniMetric({ title, value, hint }) { return <div className="mini-metric"><span>{title}</span><strong>{value}</strong>{trendHint(hint)}</div>; }
function StatCard({ title, value, hint }) { return <Card className="stat-card"><p>{title}</p><strong>{value}</strong>{hint && trendHint(hint)}</Card>; }

// A manifest-style ledger where every SP-API report line can be pulled
// independently, with its own status and last-synced timestamp. `reportTypes`
// scopes which rows show up — each sidebar page passes only the report(s) it
// actually depends on, instead of every page showing the full bundle.
function SyncLedger({ tenantId, jobs = [], onSynced, reportTypes, title, subtitle, disabled }) {
  const [rowState, setRowState] = useState({});
  const reports = reportTypes ? REPORTS.filter(r => reportTypes.includes(r.type)) : REPORTS;

  async function syncOne(reportType) {
    if (disabled) return;
    setRowState(s => ({ ...s, [reportType]: { loading: true } }));
    try {
      const result = reportType === 'DIRECT_SP_API_SYNC'
        ? await api(`/api/tenants/${tenantId}/sync`, { method: 'POST', body: JSON.stringify({ reportTypes: [] }) })
        : await api(`/api/tenants/${tenantId}/sync/${reportType}`, { method: 'POST' });
      if (result?.status === 'failed') throw new Error(result.error ?? 'Sync failed');
      const failedDirectSync = result?.results?.find?.(row => row.status === 'failed');
      if (failedDirectSync) throw new Error(failedDirectSync.error ?? 'Sync failed');
      setRowState(s => ({ ...s, [reportType]: { loading: false, justSynced: true } }));
      await onSynced?.();
    } catch (e) {
      setRowState(s => ({ ...s, [reportType]: { loading: false, error: e.message } }));
    }
  }

  if (!reports.length) {
    return (
      <Card className="ledger-card">
        <PanelHeader title={title ?? 'Sync'} subtitle={subtitle ?? 'Last 30 Days'} />
        <Empty text="This page isn't backed by a dedicated SP-API report pull yet." />
      </Card>
    );
  }

  return (
    <Card className="ledger-card">
      <PanelHeader title={title ?? 'Sync ledger'} subtitle={disabled ? 'Connect Amazon to enable sync' : (subtitle ?? 'Pull one report at a time')} />
      {disabled && <div className="ledger-locked-note">Connect your Amazon account above to pull this data — sync is disabled until then.</div>}
      <div className="ledger">
        {reports.map((report, i) => {
          const job = jobs.find(j => j.report_type === report.type);
          const local = rowState[report.type];
          const busy = local?.loading;
          const failed = local?.error || job?.status === 'failed';
          const statusLabel = disabled ? 'locked' : busy ? 'syncing' : failed ? 'failed' : job?.status ?? 'idle';
          return (
            <div className="ledger-row" key={report.type}>
              <span className="ledger-index">{String(i + 1).padStart(2, '0')}</span>
              <span className="ledger-code">{report.code}</span>
              <div className="ledger-meta">
                <b>{report.label}</b>
                <small>{local?.error ?? (job?.completed_at ? `Last synced ${timeAgo(job.completed_at)}` : report.hint)}</small>
              </div>
              <span className={`pill status-${statusLabel}`}>{statusLabel}</span>
              <Button variant="secondary" disabled={disabled || busy} onClick={() => syncOne(report.type)}>{busy ? 'Syncing…' : 'Sync'}</Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// Shows either a connected chip with a Disconnect action, or a Connect action
// when no Amazon account is linked yet — never both at once.
function AmazonConnectionPanel({ tenantId, seller, onChange, setError }) {
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try { await beginAmazonAuthorization(tenantId); }
    catch (e) { setError(e.message); setBusy(false); }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect this Amazon account? Report syncing will stop until you reconnect.')) return;
    setBusy(true);
    try {
      await api(`/api/tenants/${tenantId}/amazon/disconnect`, { method: 'POST' });
      localStorage.removeItem(`${ACCESS_TOKEN_CACHE_PREFIX}${tenantId}`);
      await onChange();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (seller?.connected) {
    return (
      <div className="amazon-chip is-connected">
        <span className="dot" />
        <div className="chip-copy"><b>{seller.sellerId}</b><small>{seller.marketplaceId}</small></div>
        <Button variant="ghost" disabled={busy} onClick={disconnect}>{busy ? 'Disconnecting…' : 'Disconnect'}</Button>
      </div>
    );
  }
  return (
    <div className="amazon-chip is-disconnected">
      <span className="dot off" />
      <div className="chip-copy"><b>Amazon not connected</b><small>Authorize Seller Central to enable sync</small></div>
      <Button disabled={busy} onClick={connect}>{busy ? 'Redirecting…' : 'Connect Amazon'}</Button>
    </div>
  );
}

function SellerDashboard() {
  const [params] = useSearchParams();
  const tenantId = params.get('tenantId') ?? '';
  const view = params.get('view') ?? 'dashboard';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [autoSyncing, setAutoSyncing] = useState(false);
  const autoSyncedRef = useRef(false);
  async function load() { setError(''); try { setData(await api(`/api/tenants/${tenantId}/dashboard`)); } catch (e) { setError(e.message); } }
  useEffect(() => { if (tenantId) void load(); }, [tenantId]);

  // Dashboard-only, once per session: as soon as we know the seller is
  // Amazon-authenticated, automatically pull the default last-30-days data
  // so the dashboard is populated without the user pressing anything. Every
  // other page stays manual — its Sync button is the only thing that syncs it.
  useEffect(() => {
    if (view !== 'dashboard') return;
    if (!data?.seller?.connected) return;
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    (async () => {
      setAutoSyncing(true);
      for (const report of REPORTS) {
        try {
          if (report.type === 'DIRECT_SP_API_SYNC') await api(`/api/tenants/${tenantId}/sync`, { method: 'POST', body: JSON.stringify({ reportTypes: [] }) });
          else await api(`/api/tenants/${tenantId}/sync/${report.type}`, { method: 'POST' });
        } catch { /* one failed report shouldn't block the rest */ }
      }
      await load();
      setAutoSyncing(false);
    })();
  }, [view, data?.seller?.connected, tenantId]);

  const channelData = useMemo(() => [
    { name: 'Order value', value: Number(data?.orders?.order_value ?? 0) },
    { name: 'Settlement earnings', value: Number(data?.kpis?.earnings ?? 0) },
    { name: 'Settlement deductions', value: Math.abs(Number(data?.kpis?.deductions ?? 0)) }
  ].filter(item => item.value > 0), [data]);
  const reportTypes = VIEW_REPORT_TYPES[view];
  const ledgerCopy = VIEW_LEDGER_COPY[view];
  const connected = !!data?.seller?.connected;

  return <div className="page-stack">
    <div className="section-title">
      <div><h1>{viewTitle(view)}</h1><p>{viewDescription(view)}</p></div>
      <div className="actions">
        <Button variant="ghost" onClick={load}>Refresh</Button>
        <AmazonConnectionPanel tenantId={tenantId} seller={data?.seller} onChange={load} setError={setError} />
      </div>
    </div>
    {error && <p className="alert warning">{error}</p>}
    {view === 'dashboard' && autoSyncing && <p className="alert success">Auto-syncing your last 30 days of data…</p>}
    {view === 'dashboard' && !connected && data && <p className="alert warning">Connect your Amazon account to start pulling data — nothing syncs until then.</p>}
    {view !== 'dashboard' && <SyncLedger tenantId={tenantId} jobs={data?.jobs ?? []} onSynced={load} reportTypes={reportTypes} title={ledgerCopy?.title} subtitle={ledgerCopy?.subtitle} disabled={!connected} />}

    {view === 'dashboard' && <DashboardOverview data={data} channelData={channelData} />}
    {view === 'sales' && <SalesAnalytics data={data} channelData={channelData} />}
    {view === 'inventory' && <TableCard title="Inventory" rows={data?.inventory ?? []} columns={['sku', 'fulfillable_quantity', 'snapshot_date']} />}
    {view === 'payouts' && <TableCard title="Payout Activity" rows={data?.payments ?? []} columns={['posted_date', 'settlement_id', 'net_amount', 'lines']} />}
    {view === 'brand' && <TableCard title="Product Performance" rows={data?.products ?? []} columns={['asin', 'units', 'sales', 'buy_box']} />}
    {view === 'health' && <div className="dashboard-grid two"><TableCard title="Returns" rows={data?.returns ?? []} columns={['order_id', 'return_reason', 'disposition', 'status', 'return_date']} /><TableCard title="Reimbursements" rows={data?.reimbursements ?? []} columns={['sku', 'amount', 'reason', 'reimbursement_date']} /></div>}
    {view === 'reports' && <div className="dashboard-grid two"><TableCard title="GST Invoices" rows={data?.invoices ?? []} columns={['invoice_type', 'order_id', 'taxable_value', 'cgst', 'sgst', 'igst', 'invoice_date']} /><TableCard title="Recent Sync Jobs" rows={data?.jobs ?? []} columns={['report_type', 'status', 'completed_at', 'error_message']} /></div>}
  </div>;
}

function viewTitle(view) { return ({ dashboard: 'Dashboard', sales: 'Sales Analytics', inventory: 'Inventory', payouts: 'Payout Reconciliation', brand: 'Brand Analytics', health: 'Account Health', reports: 'Reports' })[view] ?? 'Dashboard'; }
function viewDescription(view) { return ({ dashboard: 'Live seller KPIs populated from synced SP-API orders and reports.', sales: 'Revenue, order value, units and product sales trends from Amazon reports.', inventory: 'FBA inventory snapshots imported from SP-API inventory reports.', payouts: 'Settlement rows and payout reconciliation from Amazon settlement reports.', brand: 'ASIN-level product performance from synced Amazon order items, with Sales & Traffic metrics when available.', health: 'Returns and reimbursement signals imported from Amazon reports.', reports: 'GST/report imports and recent sync job status.' })[view] ?? 'Live seller KPIs populated from synced SP-API orders and reports.'; }
function DashboardOverview({ data, channelData }) { return <><div className="metrics-strip"><MiniMetric title="Total Revenue" value={formatCurrency(data?.orders?.order_value)} /><MiniMetric title="Units Sold" value={formatNumber(data?.products?.reduce((a, p) => a + Number(p.units ?? 0), 0))} /><MiniMetric title="Avg Order Value" value={formatCurrency(Number(data?.orders?.order_value ?? 0) / Math.max(Number(data?.orders?.orders ?? 0), 1))} /><MiniMetric title="Orders" value={formatNumber(data?.orders?.orders)} /></div><SalesAnalytics data={data} channelData={channelData} /><div className="dashboard-grid two"><TableCard title="Payment Settlements" rows={data?.payments ?? []} columns={['posted_date', 'settlement_id', 'net_amount', 'lines']} /><TableCard title="Recent Sync Jobs" rows={data?.jobs ?? []} columns={['report_type', 'status', 'completed_at', 'error_message']} /></div></>; }
function SalesAnalytics({ data, channelData }) { const { range } = useContext(DateRangeContext); return <><div className="dashboard-grid"><Card className="panel"><PanelHeader title="Sales Source Distribution" />{channelData.length ? <><ResponsiveContainer width="100%" height={220}><PieChart><Pie data={channelData} innerRadius={62} outerRadius={92} dataKey="value">{channelData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer><Legend items={channelData} /></> : <Empty text="No synced sales or settlement totals yet." />}</Card><Card className="panel wide"><PanelHeader title={`Sales Trend (${range.label})`} />{data?.trend?.length ? <ResponsiveContainer width="100%" height={250}><AreaChart data={data.trend}><defs><linearGradient id="sales" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#1f8a85" stopOpacity={0.35}/><stop offset="95%" stopColor="#1f8a85" stopOpacity={0}/></linearGradient></defs><XAxis dataKey="date" /><YAxis /><Tooltip /><Area dataKey="sales" stroke="#1f8a85" fill="url(#sales)" strokeWidth={3} /></AreaChart></ResponsiveContainer> : <Empty text="No imported sales trend yet. Use the Sync above to pull SP-API reports." />}</Card></div><div className="dashboard-grid two"><TableCard title="Product Performance" rows={data?.products ?? []} columns={['asin', 'units', 'sales', 'buy_box']} /><TableCard title="Order Items" rows={data?.orderItems ?? []} columns={['amazon_order_id', 'asin', 'sku', 'title', 'quantity_ordered', 'item_price']} /></div></>; }

function PanelHeader({ title, subtitle }) { const { range } = useContext(DateRangeContext); return <div className="panel-header"><h2>{title}</h2><span>{subtitle ?? range.label}</span></div>; }
function Legend({ items }) { return <div className="legend-list">{items.map((item, i) => <div key={item.name}><span style={{ background: COLORS[i % COLORS.length] }} />{item.name}<b>{formatCurrency(item.value)}</b></div>)}</div>; }
function TableCard({ title, rows = [], columns }) { return <Card className="table-card"><PanelHeader title={title} />{rows.length ? <div className="table-wrap"><table><thead><tr>{columns.map(c => <th key={c}>{c.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{columns.map(c => <td key={c}>{row[c] ?? '—'}</td>)}</tr>)}</tbody></table></div> : <Empty text="No data imported yet." />}</Card>; }

// Admin-only screen. Admins never see the seller sidebar/navigation — this is
// the whole of their UI: tenant table + the one place accounts get created.
function AdminDashboard() {
  const [tenants, setTenants] = useState([]); const [error, setError] = useState('');
  const [newSeller, setNewSeller] = useState({ companyName: '', ownerEmail: '', password: '' });
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState('');
  async function load() { try { setTenants((await api('/api/admin/tenants')).tenants); } catch (e) { setError(e.message); } }
  async function action(path) { await api(path, { method: 'POST' }); await load(); }
  useEffect(() => { void load(); }, []);
  const stats = useMemo(() => ({ total: tenants.length, pending: tenants.filter(t => !t.amazon_connected).length, active: tenants.filter(t => t.status === 'active').length }), [tenants]);

  async function createSeller(event) {
    event.preventDefault(); setError(''); setCreateMsg(''); setCreating(true);
    try {
      await api('/api/auth/register-seller', { method: 'POST', body: JSON.stringify(newSeller) });
      setCreateMsg(`Seller account created for ${newSeller.ownerEmail}. Share the login and temporary password with them directly.`);
      setNewSeller({ companyName: '', ownerEmail: '', password: '' });
      await load();
    } catch (e) { setError(e.message); }
    finally { setCreating(false); }
  }

  return <div className="page-stack">
    <div className="section-title"><div><h1>Admin Portal</h1><p>Seller onboarding, Amazon authorization status, and report ingestion control.</p></div></div>
    {error && <p className="alert error">{error}</p>}
    <div className="stat-grid"><StatCard title="Sellers" value={stats.total} /><StatCard title="Pending Auth" value={stats.pending} /><StatCard title="Active Tenants" value={stats.active} /></div>
    <Card className="create-seller-card">
      <PanelHeader title="Create seller account" subtitle="Admin only" />
      <form onSubmit={createSeller} className="form-row">
        <Input placeholder="Company name" value={newSeller.companyName} onChange={e => setNewSeller({ ...newSeller, companyName: e.target.value })} required />
        <Input placeholder="Owner email" type="email" value={newSeller.ownerEmail} onChange={e => setNewSeller({ ...newSeller, ownerEmail: e.target.value })} required />
        <Input placeholder="Temporary password" type="password" value={newSeller.password} onChange={e => setNewSeller({ ...newSeller, password: e.target.value })} required minLength={8} />
        <Button disabled={creating}>{creating ? 'Creating…' : 'Create seller'}</Button>
      </form>
      {createMsg && <p className="alert success">{createMsg}</p>}
    </Card>
    <Card className="table-card"><PanelHeader title="Seller Authorization Control" /><div className="table-wrap"><table><thead><tr><th>Seller</th><th>Status</th><th>Login</th><th>Amazon auth</th><th>Connected</th><th>Last sync</th><th>Actions</th></tr></thead><tbody>{tenants.map(t => <tr key={t.id}><td><b>{t.company_name}</b><small>{t.id}</small></td><td><span className={`pill status-${t.status}`}>{t.status}</span></td><td>{t.login_email ?? t.owner_email ?? '—'}</td><td>{t.amazon_connected ? `${t.seller_name ?? t.company_name} · ${t.amazon_seller_id} · ${t.auth_status}` : 'Not connected'}</td><td>{t.amazon_connected_at ? new Date(t.amazon_connected_at).toLocaleString() : '—'}</td><td>{t.last_successful_sync ?? '—'}</td><td><div className="row-actions">{t.status === 'pending' && <><Button onClick={() => action(`/api/admin/tenants/${t.id}/grant-access`)}>Grant</Button><Button variant="secondary" onClick={() => action(`/api/admin/tenants/${t.id}/reject`)}>Reject</Button></>}{t.status === 'active' && <>{REPORTS.map(r => <Button variant="secondary" key={r.type} onClick={() => action(`/api/admin/tenants/${t.id}/sync/${r.type}`)}>{r.code}</Button>)}<Button variant="danger" onClick={() => action(`/api/admin/tenants/${t.id}/revoke-access`)}>Revoke</Button></>}</div></td></tr>)}</tbody></table></div></Card>
  </div>;
}

function SidebarLink({ to, children }) {
  const location = useLocation();
  const target = new URL(to, 'http://local');
  const current = new URL(`${location.pathname}${location.search}`, 'http://local');
  const active = current.pathname === target.pathname && current.searchParams.get('view') === target.searchParams.get('view');
  return <NavLink className={active ? 'active' : ''} to={to}>{children}</NavLink>;
}

// Seller-facing shell: sidebar + topbar. Admins never render this component.
function SellerShell({ session, setSession }) {
  function logout() { localStorage.removeItem('token'); setSession(null); }
  const [range, setRange] = useState(defaultDateRange);
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="logo"><span>W</span><div><b>WELLSURE</b><small>Seller Intelligence</small></div></div>
      <nav>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=dashboard`}>Dashboard</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=sales`}>Sales Analytics</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=inventory`}>Inventory</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=payouts`}>Payouts</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=brand`}>Brand Analytics</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=health`}>Account Health</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=reports`}>Reports</SidebarLink>
      </nav>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <div className="search">⌕ Search</div>
        <select><option>Amazon.in</option></select>
        <DateRangePicker value={range} onChange={setRange} />
        <div className="avatar">{session?.email?.[0]?.toUpperCase()}</div>
        <Button variant="dark" onClick={logout}>Logout {session?.email}</Button>
      </header>
      <DateRangeContext.Provider value={{ range, setRange }}>
        <Routes>
          <Route path="/seller" element={<SellerDashboard />} />
          <Route path="*" element={<Navigate to={`/seller?tenantId=${session?.tenantId ?? ''}&view=dashboard`} replace />} />
        </Routes>
      </DateRangeContext.Provider>
    </main>
  </div>;
}

// Admin-facing shell: deliberately has NO seller sidebar/nav — admins only
// get the tenant/user control surface, nothing seller-specific.
function AdminShell({ session, setSession }) {
  function logout() { localStorage.removeItem('token'); setSession(null); }
  return <div className="admin-shell">
    <header className="admin-topbar">
      <div className="logo"><span>W</span><div><b>WELLSURE</b><small>Admin Console</small></div></div>
      <div className="admin-topbar-right">
        <div className="avatar">{session?.email?.[0]?.toUpperCase()}</div>
        <Button variant="dark" onClick={logout}>Logout {session?.email}</Button>
      </div>
    </header>
    <main className="admin-workspace">
      <Routes>
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </main>
  </div>;
}

function App() {
  const [session, setSession] = useState(null);
  useEffect(() => { const token = localStorage.getItem('token'); if (token) api('/api/auth/me').then(d => setSession(d.user)).catch(() => localStorage.removeItem('token')); }, []);
  if (!session) return <BrowserRouter><Login setSession={setSession} /></BrowserRouter>;
  return <BrowserRouter>{session.role === 'admin' ? <AdminShell session={session} setSession={setSession} /> : <SellerShell session={session} setSession={setSession} />}</BrowserRouter>;
}

createRoot(document.getElementById('root')).render(<App />);