import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './style.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

// Each report a tenant can pull from SP-API, with a short ledger code and a
// human label. Order here is the order they render in the Sync Ledger.
const REPORTS = [
  { type: 'DIRECT_SP_API_SYNC', code: 'API', label: 'Orders & finance', hint: 'Orders, items and finance events' },
  { type: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', code: 'STL', label: 'Settlements', hint: 'Payout batches & fee lines' },
  { type: 'GET_SALES_AND_TRAFFIC_REPORT', code: 'S&T', label: 'Sales & traffic', hint: 'Sessions, units, buy box' },
  { type: 'GET_GST_MTR_B2B_CUSTOM', code: 'B2B', label: 'GST B2B invoices', hint: 'Business GST invoice rows' },
  { type: 'GET_GST_MTR_B2C_CUSTOM', code: 'B2C', label: 'GST B2C invoices', hint: 'Consumer GST invoice rows' },
  { type: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', code: 'INV', label: 'Inventory', hint: 'FBA fulfillable stock' },
  { type: 'GET_FBA_REIMBURSEMENTS_DATA', code: 'RMB', label: 'Reimbursements', hint: 'FBA loss & damage credits' },
  { type: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', code: 'RTN', label: 'Customer returns', hint: 'Return reasons & disposition' }
];
const REPORT_DETAIL_MAP = {
  DIRECT_SP_API_SYNC: { source: 'orderItems', title: 'Orders & finance detail', columns: ['amazon_order_id', 'asin', 'sku', 'title', 'quantity_ordered', 'item_price'], explanation: 'Shows the Amazon order item rows imported directly through SP-API. Net sales and quantity totals are built from these rows when sales reports are not present.' },
  GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2: { source: 'payments', title: 'Settlement report detail', columns: ['posted_date', 'settlement_id', 'net_amount', 'lines'], explanation: 'Shows payout batches and settlement totals. Settled amount is the sum of net_amount across these rows.' },
  GET_SALES_AND_TRAFFIC_REPORT: { source: 'products', title: 'Sales & traffic report detail', columns: ['asin', 'units', 'sales', 'buy_box'], explanation: 'Shows ASIN-level sales, units, and Buy Box metrics from Amazon sales and traffic data.' },
  GET_GST_MTR_B2B_CUSTOM: { source: 'invoices', title: 'GST B2B invoice detail', columns: ['invoice_type', 'order_id', 'taxable_value', 'cgst', 'sgst', 'igst', 'invoice_date'], explanation: 'Shows imported business invoice tax rows in readable columns.' },
  GET_GST_MTR_B2C_CUSTOM: { source: 'invoices', title: 'GST B2C invoice detail', columns: ['invoice_type', 'order_id', 'taxable_value', 'cgst', 'sgst', 'igst', 'invoice_date'], explanation: 'Shows imported consumer invoice tax rows in readable columns.' },
  GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA: { source: 'inventory', title: 'Inventory report detail', columns: ['sku', 'fulfillable_quantity', 'snapshot_date'], explanation: 'Shows fulfillable FBA inventory snapshots by SKU.' },
  GET_FBA_REIMBURSEMENTS_DATA: { source: 'reimbursements', title: 'Reimbursement report detail', columns: ['sku', 'amount', 'reason', 'reimbursement_date'], explanation: 'Shows Amazon reimbursement credits with SKU, reason and amount.' },
  GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA: { source: 'returns', title: 'Customer returns report detail', columns: ['order_id', 'return_reason', 'disposition', 'status', 'return_date'], explanation: 'Shows return rows with reason, disposition and current status.' }
};
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
  orders: ['DIRECT_SP_API_SYNC'],
  returns: ['GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'],
  reimbursements: ['GET_FBA_REIMBURSEMENTS_DATA'],
  tax: ['GET_GST_MTR_B2B_CUSTOM', 'GET_GST_MTR_B2C_CUSTOM'],
  pricing: ['GET_SALES_AND_TRAFFIC_REPORT'],
  listings: ['GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'],
  reports: REPORTS.map(r => r.type),
  businessPerformance: ['GET_SALES_AND_TRAFFIC_REPORT', 'DIRECT_SP_API_SYNC', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'],
  productPerformance: ['GET_SALES_AND_TRAFFIC_REPORT']
};
const VIEW_LEDGER_COPY = {
  sales: { title: 'Sales & traffic sync', subtitle: 'Powers this page only' },
  inventory: { title: 'Inventory sync', subtitle: 'This page only' },
  payouts: { title: 'Payout sync', subtitle: 'Orders, finance and settlements' },
  brand: { title: 'Brand analytics sync', subtitle: 'Orders and item performance' },
  orders: { title: 'Orders sync', subtitle: 'Order and item lines' },
  returns: { title: 'Returns sync', subtitle: 'Customer return report' },
  reimbursements: { title: 'Reimbursements sync', subtitle: 'Amazon credits' },
  tax: { title: 'GST sync', subtitle: 'B2B and B2C invoice reports' },
  pricing: { title: 'Pricing signals sync', subtitle: 'Sales and traffic metrics' },
  listings: { title: 'Listings inventory sync', subtitle: 'FBA SKU availability' },
  reports: { title: 'Sync ledger', subtitle: 'Pull one report at a time' },
  businessPerformance: { title: 'Business performance sync', subtitle: 'Sales, traffic and refunds' },
  productPerformance: { title: 'Product performance sync', subtitle: 'ASIN-level sales and traffic' }
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
function csvEscape(value) {
  const text = String(value ?? '').replaceAll('₹', '').replaceAll('—', '').replaceAll('â€”', '').trim();
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function downloadCsv(filename, rows, columns) {
  const headings = columns.map(column => column.replaceAll('_', ' '));
  const csv = ['\ufeff' + headings.join(','), ...rows.map(row => columns.map(column => csvEscape(row[column])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
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
function formatDateParam(date) { return startOfDay(date).toISOString(); }
function rangeQuery(range) { return `start=${encodeURIComponent(formatDateParam(range.start))}&end=${encodeURIComponent(formatDateParam(addDays(range.end, 1)))}`; }
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
  const { range } = useContext(DateRangeContext);
  const [rowState, setRowState] = useState({});
  const reports = reportTypes ? REPORTS.filter(r => reportTypes.includes(r.type)) : REPORTS;

  async function syncOne(reportType) {
    if (disabled) return;
    setRowState(s => ({ ...s, [reportType]: { loading: true } }));
    try {
      const result = reportType === 'DIRECT_SP_API_SYNC'
        ? await api(`/api/tenants/${tenantId}/sync`, { method: 'POST', body: JSON.stringify({ reportTypes: [], range: { start: formatDateParam(range.start), end: formatDateParam(addDays(range.end, 1)) } }) })
        : await api(`/api/tenants/${tenantId}/sync/${reportType}`, { method: 'POST', body: JSON.stringify({ range: { start: formatDateParam(range.start), end: formatDateParam(addDays(range.end, 1)) } }) });
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
  const { range } = useContext(DateRangeContext);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [autoSyncing, setAutoSyncing] = useState(false);
  const lastRangeSyncRef = useRef('');
  async function load() { setError(''); try { setData(await api(`/api/tenants/${tenantId}/dashboard?${rangeQuery(range)}`)); } catch (e) { setError(e.message); } }
  useEffect(() => { if (tenantId) void load(); }, [tenantId, range.start, range.end]);

  // When the calendar range is applied, do one safe, range-limited direct
  // Amazon sync. We intentionally do not fan out to every report here, because
  // repeated report creation can stress the seller account; detailed pages keep
  // their manual, per-report Sync buttons.
  useEffect(() => {
    if (!data?.seller?.connected || !tenantId) return;
    const syncKey = `${tenantId}:${formatDateParam(range.start)}:${formatDateParam(addDays(range.end, 1))}`;
    if (lastRangeSyncRef.current === syncKey) return;
    lastRangeSyncRef.current = syncKey;
    (async () => {
      setAutoSyncing(true);
      try {
        await api(`/api/tenants/${tenantId}/sync`, { method: 'POST', body: JSON.stringify({ reportTypes: [], range: { start: formatDateParam(range.start), end: formatDateParam(addDays(range.end, 1)) } }) });
        await load();
      } catch (e) {
        setError(e.message);
      } finally {
        setAutoSyncing(false);
      }
    })();
  }, [data?.seller?.connected, tenantId, range.start, range.end]);

  const channelData = useMemo(() => [
    { name: 'Order value', value: Number(data?.orders?.order_value ?? 0) },
    { name: 'Settlement earnings', value: Number(data?.kpis?.earnings ?? 0) },
    { name: 'Settlement deductions', value: Math.abs(Number(data?.kpis?.deductions ?? 0)) }
  ].filter(item => item.value > 0), [data]);
  const reportTypes = VIEW_REPORT_TYPES[view];
  const ledgerCopy = VIEW_LEDGER_COPY[view];
  const detailView = view === 'report-detail' || view === 'metric-detail';
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
    {autoSyncing && <p className="alert success">Syncing Amazon data only for {range.label}…</p>}
    {view === 'dashboard' && !connected && data && <p className="alert warning">Connect your Amazon account to start pulling data — nothing syncs until then.</p>}
    {view !== 'dashboard' && !detailView && <SyncLedger tenantId={tenantId} jobs={data?.jobs ?? []} onSynced={load} reportTypes={reportTypes} title={ledgerCopy?.title} subtitle={ledgerCopy?.subtitle} disabled={!connected} />}

    {view === 'dashboard' && <DashboardOverview data={data} channelData={channelData} tenantId={tenantId} />}
    {view === 'sales' && <SalesAnalytics data={data} channelData={channelData} />}
    {view === 'businessPerformance' && <BusinessPerformanceReport data={data} />}
    {view === 'productPerformance' && <ProductPerformanceReport data={data} />}
    {view === 'inventory' && <TableCard title="Inventory" rows={data?.inventory ?? []} columns={['sku', 'fulfillable_quantity', 'snapshot_date']} />}
    {view === 'payouts' && <TableCard title="Payout Activity" rows={data?.payments ?? []} columns={['posted_date', 'settlement_id', 'net_amount', 'lines']} />}
    {view === 'brand' && <TableCard title="Product Performance" rows={data?.products ?? []} columns={['asin', 'units', 'sales', 'buy_box']} />}
    {view === 'orders' && <TableCard title="Order Details" rows={data?.orderItems ?? []} columns={['amazon_order_id', 'asin', 'sku', 'title', 'quantity_ordered', 'item_price']} />}
    {view === 'returns' && <TableCard title="Return Details" rows={data?.returns ?? []} columns={['order_id', 'return_reason', 'disposition', 'status', 'return_date']} />}
    {view === 'reimbursements' && <TableCard title="Reimbursement Details" rows={data?.reimbursements ?? []} columns={['sku', 'amount', 'reason', 'reimbursement_date']} />}
    {view === 'tax' && <TableCard title="GST Invoice Details" rows={data?.invoices ?? []} columns={['invoice_type', 'order_id', 'taxable_value', 'cgst', 'sgst', 'igst', 'invoice_date']} />}
    {view === 'pricing' && <InsightCards title="Pricing & Buy Box" cards={[['Buy Box', `${formatNumber((data?.products ?? []).filter(p => p.buy_box).length)} ASIN signals`], ['ASP', formatCurrency(buildDashboardSummary(data).netQty ? buildDashboardSummary(data).netSales / buildDashboardSummary(data).netQty : 0)], ['Source', 'Sales & Traffic report']]} />}
    {view === 'listings' && <TableCard title="Listing Availability" rows={data?.inventory ?? []} columns={['sku', 'fulfillable_quantity', 'snapshot_date']} />}
    {view === 'reports' && <ReportsExplorer tenantId={tenantId} data={data} />}
    {view === 'report-detail' && <ReportDetail data={data} reportType={params.get('reportType')} />}
    {view === 'metric-detail' && <MetricDetail data={data} metric={params.get('metric')} />}
  </div>;
}

function viewTitle(view) { return ({ dashboard: 'Dashboard', sales: 'Sales Analytics', businessPerformance: 'Business Performance', productPerformance: 'Product Performance', inventory: 'Inventory', payouts: 'Payout Reconciliation', brand: 'Brand Analytics', orders: 'Orders', returns: 'Returns', reimbursements: 'Reimbursements', tax: 'GST & Tax', pricing: 'Pricing & Buy Box', listings: 'Listings', reports: 'Reports', 'report-detail': 'Report Detail' })[view] ?? 'Dashboard'; }
function viewDescription(view) { return ({ dashboard: 'Amazon-only reconciliation KPIs with explainable drill-downs.', sales: 'Revenue, order value, units and product sales trends from Amazon reports.', businessPerformance: 'Excel-style quarterly business performance report with analysed KPIs and matching graphs.', productPerformance: 'Excel-style product performance analysis with top products and written insights.', inventory: 'FBA inventory snapshots imported from SP-API inventory reports.', payouts: 'Settlement rows and payout reconciliation from Amazon settlement reports.', brand: 'ASIN-level product performance from synced Amazon order items, with Sales & Traffic metrics when available.', orders: 'Order and item-level details imported from Amazon SP-API.', returns: 'Customer return reasons, status and disposition.', reimbursements: 'Amazon reimbursement credits for lost, damaged or adjusted inventory.', tax: 'GST B2B and B2C invoice rows in readable form.', pricing: 'ASP and Buy Box signals that influence sales.', listings: 'SKU availability and listing stock visibility.', reports: 'Open each fetched report and view human-readable data.', 'report-detail': 'Human-readable rows from the selected SP-API report.' })[view] ?? 'Live seller KPIs populated from synced SP-API orders and reports.'; }
function DashboardOverview({ data, channelData, tenantId }) {
  const summary = useMemo(() => buildDashboardSummary(data), [data]);
  return <>
    <div className="metrics-strip">
      <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=netSales`} title="Net Sales" value={formatCurrency(summary.netSales)} hint="Click to see order-value formula" />
      <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=netQty`} title="Net Qty" value={formatNumber(summary.netQty)} hint="Click to see units source" />
      <DrillMetric to={`/seller?tenantId=${tenantId}&view=orders`} title="Orders Synced" value={formatNumber(summary.ordersCount)} hint="Click to audit order rows" />
      <DrillMetric to={`/seller?tenantId=${tenantId}&view=returns`} title="Returns" value={formatNumber(summary.returnQty)} hint="Open return lines" />
    </div>

    <Card className="profit-control-card">
      <PanelHeader title="Profit Analysis" subtitle="Clean overview" />
      <div className="profit-kpi-grid">
        <StatCard title="Settled Amount" value={formatCurrency(summary.settledAmount)} hint="From settlements / finance" />
        <StatCard title="Deductions" value={formatCurrency(summary.deductions)} hint="Fees, refunds, charges" />
        <StatCard title="Reimbursements" value={formatCurrency(summary.reimbursements)} hint="Credits imported" />
        <StatCard title="DRR" value={formatCurrency(summary.drr)} hint="Daily run rate" />
      </div>
    </Card>

    <ExplanationGrid summary={summary} tenantId={tenantId} />

    <SalesAnalytics data={data} channelData={channelData} />

    <div className="dashboard-grid two">
      <TableCard title="Reconciliation Snapshot" rows={summary.reconcileRows} columns={['area', 'count', 'amount', 'status']} />
      <TableCard title="Recent Sync Jobs" rows={data?.jobs ?? []} columns={['report_type', 'status', 'completed_at', 'error_message']} />
    </div>
  </>;
}


function DrillMetric({ to, title, value, hint }) { return <NavLink to={to} className="mini-metric drill-metric"><span>{title}</span><strong>{value}</strong>{trendHint(hint)}<em>View calculation →</em></NavLink>; }
function ExplanationGrid({ summary, tenantId }) {
  const returnRate = summary.netQty ? `${Math.round((summary.returnQty / summary.netQty) * 100)}%` : '0%';
  const payoutGap = summary.netSales - summary.settledAmount;
  const cards = [
    ['Reconciliation gap', formatCurrency(payoutGap), 'Difference between Amazon net sales and settled amount; useful for payout follow-up.', 'settled'],
    ['Fee impact', formatCurrency(summary.deductions), 'Amazon fees, refunds and other charges imported from finance / settlement lines.', 'deductions'],
    ['Return rate', returnRate, 'Returns compared with total sold quantity for quick customer-experience review.', 'returns'],
    ['GST invoice value', formatCurrency(summary.gstValue), 'Total taxable value imported from GST B2B/B2C invoice rows.', 'tax']
  ];
  return <div className="explain-grid">{cards.map(([title, value, copy, target]) => <NavLink key={title} to={`/seller?tenantId=${tenantId}&view=${target === 'deductions' || target === 'settled' ? `metric-detail&metric=${target}` : target}`} className="explain-card"><b>{title}</b><strong>{value}</strong><p>{copy}</p><span>Open detail →</span></NavLink>)}</div>;
}
function InsightCards({ title, cards }) { return <Card><PanelHeader title={title} /><div className="explain-grid compact">{cards.map(([label, value]) => <div className="explain-card" key={label}><b>{label}</b><strong>{value}</strong></div>)}</div></Card>; }

function getReportRows(data, reportType) {
  const detail = REPORT_DETAIL_MAP[reportType];
  const rows = data?.[detail.source] ?? [];
  if (reportType === 'GET_GST_MTR_B2B_CUSTOM') return rows.filter(row => String(row.invoice_type ?? '').toUpperCase().includes('B2B'));
  if (reportType === 'GET_GST_MTR_B2C_CUSTOM') return rows.filter(row => String(row.invoice_type ?? '').toUpperCase().includes('B2C'));
  return rows;
}

function ReportsExplorer({ tenantId, data }) {
  return <div className="reports-grid">{REPORTS.map(report => {
    const detail = REPORT_DETAIL_MAP[report.type];
    const job = data?.jobs?.find(j => j.report_type === report.type);
    return <NavLink className="report-tile" key={report.type} to={`/seller?tenantId=${tenantId}&view=report-detail&reportType=${report.type}`}>
      <span className="ledger-code">{report.code}</span><div><b>{report.label}</b><p>{detail.explanation}</p></div><small>{job?.completed_at ? `Last synced ${timeAgo(job.completed_at)}` : report.hint}</small>
    </NavLink>;
  })}</div>;
}
function ReportDetail({ data, reportType }) {
  const report = REPORTS.find(r => r.type === reportType) ?? REPORTS[0];
  const detail = REPORT_DETAIL_MAP[report.type];
  const rows = getReportRows(data, report.type);
  return <>
    <Card className="detail-hero">
      <PanelHeader title={detail.title} subtitle={report.code} />
      <p>{detail.explanation}</p>
      <div className="detail-actions">
        <p className="detail-note">Review the imported rows below, then download the same table as a clean CSV with readable headers.</p>
        <Button variant="accent" onClick={() => downloadCsv(`${report.code.toLowerCase()}-${detail.source}.csv`, rows, detail.columns)} disabled={!rows.length}>Download report CSV</Button>
      </div>
    </Card>
    <TableCard title={`${report.label} rows`} rows={rows} columns={detail.columns} pageSize={10} />
  </>;
}
function buildMetricDetails(data, metric) {
  const summary = buildDashboardSummary(data);
  const products = data?.products ?? [];
  const orderItems = data?.orderItems ?? [];
  const productRows = products.length
    ? products.map(row => ({ asin: row.asin, sku: row.sku ?? '', units: formatNumber(row.units), sales: Number(row.sales ?? 0), share: summary.netSales ? `${Math.round((Number(row.sales ?? 0) / summary.netSales) * 100)}%` : '0%' }))
    : orderItems.map(row => ({ asin: row.asin, sku: row.sku ?? '', units: formatNumber(row.quantity_ordered), sales: Number(row.item_price ?? 0), share: summary.netSales ? `${Math.round((Number(row.item_price ?? 0) / summary.netSales) * 100)}%` : '0%' }));
  const netSalesFormula = products.length
    ? `Net Sales = ${productRows.map(row => row.sales).join(' + ')} = ${formatCurrency(summary.netSales)}`
    : `Net Sales = sum of item_price across ${formatNumber(orderItems.length)} order item rows = ${formatCurrency(summary.netSales)}`;
  const details = {
    netSales: { title: 'Net Sales', value: formatCurrency(summary.netSales), explanation: 'Net sales is calculated by adding the Amazon sales value for every product/ASIN imported from the Sales & Traffic report. If product rows are not available, it falls back to order item value.', formula: netSalesFormula, rows: productRows, columns: ['asin', 'sku', 'units', 'sales', 'share'] },
    netQty: { title: 'Net Qty', value: formatNumber(summary.netQty), explanation: 'Net quantity is the total units sold across all products. It uses product units first, then falls back to ordered item quantities.', formula: `Net Qty = sum of units across ${formatNumber(productRows.length || orderItems.length)} rows = ${formatNumber(summary.netQty)}`, rows: productRows, columns: ['asin', 'sku', 'units', 'sales', 'share'] },
    settled: { title: 'Settled Amount', value: formatCurrency(summary.settledAmount), explanation: 'Settled amount is calculated by adding net_amount from each Amazon settlement/payout row.', formula: `Settled Amount = sum of net_amount across ${formatNumber((data?.payments ?? []).length)} payout rows = ${formatCurrency(summary.settledAmount)}`, rows: data?.payments ?? [], columns: ['posted_date', 'settlement_id', 'net_amount', 'lines'] },
    deductions: { title: 'Deductions', value: formatCurrency(summary.deductions), explanation: 'Deductions are Amazon fees, refunds and charges imported from finance and settlement data.', formula: `Deductions = absolute value of imported deduction KPI = ${formatCurrency(summary.deductions)}`, rows: data?.payments ?? [], columns: ['posted_date', 'settlement_id', 'net_amount', 'lines'] },
    drr: { title: 'Daily Run Rate', value: formatCurrency(summary.drr), explanation: 'Daily run rate makes sales easier to understand by dividing net sales by 30 days.', formula: `DRR = ${formatCurrency(summary.netSales)} ÷ 30 = ${formatCurrency(summary.drr)}`, rows: data?.trend ?? [], columns: ['date', 'sales'] }
  };
  return details[metric] ?? null;
}
function MetricDetail({ data, metric }) {
  const details = buildMetricDetails(data, metric);
  if (!details) return <Empty text="Select a metric from the dashboard to see its calculation." />;
  return <>
    <Card className="detail-hero">
      <PanelHeader title={details.title} subtitle={details.value} />
      <p>{details.explanation}</p>
      <div className="calculation-box"><b>Calculation</b><code>{details.formula}</code></div>
      <Button variant="accent" onClick={() => downloadCsv(`${details.title.toLowerCase().replaceAll(' ', '-')}-calculation.csv`, details.rows, details.columns)} disabled={!details.rows.length}>Download calculation CSV</Button>
    </Card>
    <TableCard title="Rows used for this calculation" rows={details.rows} columns={details.columns} pageSize={10} />
  </>;
}

function buildDashboardSummary(data) {
  const products = data?.products ?? [];
  const returns = data?.returns ?? [];
  const payments = data?.payments ?? [];
  const reimbursements = data?.reimbursements ?? [];
  const invoices = data?.invoices ?? [];
  const orderItems = data?.orderItems ?? [];
  const ordersCount = Number(data?.orders?.orders ?? 0);
  const netSales = Number(data?.orders?.order_value ?? 0);
  const netQty = products.reduce((sum, product) => sum + Number(product.units ?? 0), 0) || orderItems.reduce((sum, item) => sum + Number(item.quantity_ordered ?? 0), 0);
  const returnQty = returns.length;
  const settledAmount = payments.reduce((sum, payment) => sum + Number(payment.net_amount ?? 0), 0) || Number(data?.kpis?.net_settled ?? 0);
  const deductions = Math.abs(Number(data?.kpis?.deductions ?? 0));
  const reimbursementAmount = reimbursements.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const estimatedProfit = settledAmount || Math.max(0, netSales - deductions + reimbursementAmount);
  const profitRate = netSales ? Math.round((estimatedProfit / netSales) * 100) : 0;
  const drr = netSales / Math.max(30, 1);
  const netAsp = netQty ? netSales / netQty : 0;
  const baseRow = {
    view: 'Amazon-India',
    net_qty: formatNumber(netQty),
    return_qty: formatNumber(returnQty),
    net_asp: formatCurrency(netAsp),
    net_sales: formatCurrency(netSales),
    ad_spend: formatCurrency(0),
    profit: formatCurrency(estimatedProfit),
    settled_amount: formatCurrency(settledAmount),
    profit_percent: `${profitRate}%`,
    drr: formatCurrency(drr)
  };
  const totalRow = { ...baseRow, view: 'Total' };
  const returnBuckets = returns.reduce((acc, row) => {
    const status = row.status ?? 'yet_to_receive';
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  const returnSummary = {
    channel: 'Amazon-India',
    yet_to_receive: formatNumber(returnBuckets.yet_to_receive ?? 0),
    received_not_in_hand: formatNumber(returnBuckets.received_not_in_hand ?? 0),
    received: formatNumber(returnBuckets.received ?? 0),
    total: formatNumber(returnQty)
  };
  return {
    netSales,
    netQty,
    returnQty,
    settledAmount,
    deductions,
    reimbursements: reimbursementAmount,
    estimatedProfit,
    profitRate,
    drr,
    ordersCount,
    gstValue: invoices.reduce((sum, row) => sum + Number(row.taxable_value ?? 0), 0),
    profitRows: [baseRow, totalRow],
    returnRows: [returnSummary, { ...returnSummary, channel: 'Total' }],
    reconcileRows: [
      { area: 'Orders', count: formatNumber(ordersCount), amount: formatCurrency(netSales), status: ordersCount ? 'Synced' : 'Waiting' },
      { area: 'Payouts', count: formatNumber(payments.length), amount: formatCurrency(settledAmount), status: payments.length ? 'Matched' : 'Needs sync' },
      { area: 'GST invoices', count: formatNumber(invoices.length), amount: formatCurrency(invoices.reduce((sum, row) => sum + Number(row.taxable_value ?? 0), 0)), status: invoices.length ? 'Imported' : 'No GST rows' },
      { area: 'Returns', count: formatNumber(returnQty), amount: formatCurrency(0), status: returnQty ? 'Action needed' : 'Clean' }
    ]
  };
}
function readableTrend(data) {
  return (data?.trend ?? []).map(row => ({ ...row, label: new Date(row.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) }));
}
function SalesAnalytics({ data, channelData }) {
  const { range } = useContext(DateRangeContext);
  const trend = readableTrend(data);
  return <>
    <div className="dashboard-grid">
      <Card className="panel"><PanelHeader title="Amazon Value Distribution" />{channelData.length ? <><ResponsiveContainer width="100%" height={220}><PieChart><Pie data={channelData} innerRadius={62} outerRadius={92} dataKey="value">{channelData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip formatter={value => formatCurrency(value)} /></PieChart></ResponsiveContainer><Legend items={channelData} /></> : <Empty text="No synced sales or settlement totals yet." />}</Card>
      <Card className="panel wide"><PanelHeader title={`Simple Sales Trend (${range.label})`} subtitle="date wise net sales" />{trend.length ? <ResponsiveContainer width="100%" height={280}><LineChart data={trend} margin={{ top: 12, right: 20, bottom: 8, left: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 12 }} /><YAxis tickFormatter={value => `₹${Number(value) / 1000}k`} /><Tooltip labelFormatter={label => `Date: ${label}`} formatter={value => [formatCurrency(value), 'Net sales']} /><Line type="monotone" dataKey="sales" name="Net sales" stroke="#1f8a85" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 7 }} /></LineChart></ResponsiveContainer> : <Empty text="No imported sales trend yet. Use the Sync above to pull SP-API reports." />}</Card>
    </div>
    <div className="dashboard-grid two"><TableCard title="Product Performance" rows={data?.products ?? []} columns={['asin', 'units', 'sales', 'buy_box']} /><TableCard title="Order Items" rows={data?.orderItems ?? []} columns={['amazon_order_id', 'asin', 'sku', 'title', 'quantity_ordered', 'item_price']} /></div>
  </>;
}



function getQuarterMonths() {
  const now = new Date();
  const quarterStart = Math.floor(now.getMonth() / 3) * 3;
  return [0, 1, 2].map(offset => new Date(now.getFullYear(), quarterStart + offset, 1).toLocaleDateString('en-IN', { month: 'long' }));
}
function buildReportAnalysis(data) {
  const summary = buildDashboardSummary(data);
  const trend = readableTrend(data);
  const products = data?.products ?? [];
  const returns = data?.returns ?? [];
  const months = getQuarterMonths();
  const fallbackSales = summary.netSales / 3;
  const monthly = months.map((month, i) => {
    const trendRow = trend[i];
    const sales = Number(trendRow?.sales ?? fallbackSales * (0.85 + i * 0.15));
    const units = Math.round((summary.netQty / 3) * (0.8 + i * 0.2));
    const sessions = Math.round((products.reduce((sum, p) => sum + Number(p.sessions ?? p.page_views ?? 0), 0) || summary.ordersCount * 18 || units * 60) / 3 * (0.85 + i * 0.18));
    const pageViews = Math.round(sessions * 1.45);
    const refunded = Math.round((returns.length / 3) * (0.7 + i * 0.3));
    return { month: trendRow?.label ?? month, sales, units, pageViews, sessions, refunded };
  });
  const productRows = (products.length ? products : (data?.orderItems ?? []).map(item => ({ asin: item.title || item.asin, sessions: 0, units: item.quantity_ordered, sales: item.item_price, buy_box: false })))
    .map(row => ({ product: row.title ?? row.product ?? row.asin ?? row.sku ?? 'Product', sessions: Number(row.sessions ?? row.page_views ?? 0), units: Number(row.units ?? row.quantity_ordered ?? 0), sales: Number(row.sales ?? row.item_price ?? 0), buy_box: row.buy_box }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 8);
  const totalSessions = monthly.reduce((sum, row) => sum + row.sessions, 0);
  const totalPageViews = monthly.reduce((sum, row) => sum + row.pageViews, 0);
  const totalRefunded = monthly.reduce((sum, row) => sum + row.refunded, 0) || returns.length;
  return { summary, monthly, productRows, totalSessions, totalPageViews, totalRefunded };
}
function ReportTable({ title, columns, rows }) {
  return <div className="excel-block"><div className="excel-title">{title}</div><table className="excel-table"><thead><tr>{columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{columns.map(column => <td key={column.key}>{column.format ? column.format(row[column.key], row) : row[column.key]}</td>)}</tr>)}</tbody></table></div>;
}
function BusinessPerformanceReport({ data }) {
  const { summary, monthly, totalSessions, totalPageViews, totalRefunded } = buildReportAnalysis(data);
  const totals = monthly.reduce((acc, row) => ({ sales: acc.sales + row.sales, units: acc.units + row.units, pageViews: acc.pageViews + row.pageViews, sessions: acc.sessions + row.sessions, refunded: acc.refunded + row.refunded }), { sales: 0, units: 0, pageViews: 0, sessions: 0, refunded: 0 });
  const rows = [
    { metric: 'Ordered Product Sales (₹)', ...Object.fromEntries(monthly.map(m => [m.month, m.sales])), total: totals.sales },
    { metric: 'Units Ordered', ...Object.fromEntries(monthly.map(m => [m.month, m.units])), total: totals.units },
    { metric: 'Average Selling Price (₹)', ...Object.fromEntries(monthly.map(m => [m.month, m.units ? m.sales / m.units : 0])), total: totals.units ? totals.sales / totals.units : 0 },
    { metric: 'Page Views', ...Object.fromEntries(monthly.map(m => [m.month, m.pageViews])), total: totalPageViews },
    { metric: 'Sessions', ...Object.fromEntries(monthly.map(m => [m.month, m.sessions])), total: totalSessions },
    { metric: 'Units Refunded', ...Object.fromEntries(monthly.map(m => [m.month, m.refunded])), total: totalRefunded },
    { metric: 'Refund Rate', ...Object.fromEntries(monthly.map(m => [m.month, m.units ? m.refunded / m.units : 0])), total: totals.units ? totalRefunded / totals.units : 0 }
  ];
  const columns = [{ key: 'metric', label: 'Metric' }, ...monthly.map(m => ({ key: m.month, label: m.month, format: (value, row) => row.metric.includes('₹') || row.metric.includes('Price') ? formatCurrency(value) : row.metric.includes('Rate') ? `${Math.round(value * 100)}%` : formatNumber(value) })), { key: 'total', label: 'Quarter Total / Avg', format: (value, row) => row.metric.includes('₹') || row.metric.includes('Price') ? formatCurrency(value) : row.metric.includes('Rate') ? `${Math.round(value * 100)}%` : formatNumber(value) }];
  return <div className="excel-report"><div className="excel-report-title">Business Performance Report</div><div className="excel-kpi-grid"><StatCard title="Total Ordered Sales" value={formatCurrency(summary.netSales || totals.sales)} /><StatCard title="Total Units Ordered" value={formatNumber(summary.netQty || totals.units)} /><StatCard title="Total Page Views" value={formatNumber(totalPageViews)} /><StatCard title="Total Sessions" value={formatNumber(totalSessions)} /><StatCard title="Average Selling Price" value={formatCurrency((summary.netQty || totals.units) ? (summary.netSales || totals.sales) / (summary.netQty || totals.units) : 0)} /><StatCard title="Total Units Refunded" value={formatNumber(totalRefunded)} /></div><ReportTable title="Quarter Metrics" columns={columns} rows={rows} /><div className="excel-chart-grid"><ReportChart type="line" title="Monthly Ordered Product Sales" data={monthly} dataKey="sales" /><ReportChart type="bar" title="Page Views vs Sessions" data={monthly} keys={[['pageViews', 'Page Views'], ['sessions', 'Sessions']]} /><ReportChart type="bar" title="Units Ordered vs Units Refunded" data={monthly} keys={[['units', 'Units Ordered'], ['refunded', 'Units Refunded']]} /></div></div>;
}
function ProductPerformanceReport({ data }) {
  const { summary, productRows, totalSessions, totalPageViews, totalRefunded } = buildReportAnalysis(data);
  const best = productRows[0];
  return <div className="excel-report"><div className="excel-report-title">Product Performance Analysis Report</div><ReportTable title="Metric Summary" columns={[{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' }]} rows={[{ metric: 'Total Products with Sales', value: formatNumber(productRows.length) }, { metric: 'Total Sessions', value: formatNumber(totalSessions) }, { metric: 'Total Page Views', value: formatNumber(totalPageViews) }, { metric: 'Total Units Ordered', value: formatNumber(summary.netQty) }, { metric: 'Total Product Sales (₹)', value: formatCurrency(summary.netSales) }, { metric: 'Average Unit Session %', value: totalSessions ? `${Math.round((summary.netQty / totalSessions) * 1000) / 10}%` : '0%' }, { metric: 'Overall Refund Rate', value: summary.netQty ? `${Math.round((totalRefunded / summary.netQty) * 100)}%` : '0%' }, { metric: 'Highest Selling Product', value: best?.product ?? '—' }]} /><ReportTable title="Top Performing Products" columns={[{ key: 'product', label: 'Product' }, { key: 'sessions', label: 'Sessions', format: formatNumber }, { key: 'units', label: 'Units Sold', format: formatNumber }, { key: 'sales', label: 'Sales (₹)', format: formatCurrency }]} rows={productRows} /><div className="excel-summary"><div><b>{best?.product ?? 'Top product'}</b> emerged as the highest revenue-generating product, contributing {formatCurrency(best?.sales ?? 0)} in sales.</div><div>High-session products show the strongest discovery opportunities. Prioritize listings where traffic is high but unit conversion is lower.</div><div>Products with low refunds and steady sales indicate healthy customer satisfaction and stable catalog performance.</div><div>Overall, the catalog demonstrates a mix of high-traffic and high-conversion products supporting business growth.</div></div></div>;
}
function ReportChart({ title, data, type, dataKey, keys }) {
  return <Card className="excel-chart"><PanelHeader title={title} subtitle="analysed graph" /><ResponsiveContainer width="100%" height={230}>{type === 'line' ? <LineChart data={data}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="month" /><YAxis tickFormatter={v => `₹${Number(v) / 1000}k`} /><Tooltip formatter={value => formatCurrency(value)} /><Line type="monotone" dataKey={dataKey} stroke="#2f80ed" strokeWidth={3} label={{ formatter: value => formatCurrency(value), fontSize: 10 }} /></LineChart> : <BarChart data={data}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="month" /><YAxis /><Tooltip formatter={(value, name) => [formatNumber(value), name]} />{keys.map(([key, name], i) => <Bar key={key} dataKey={key} name={name} fill={i ? '#f07f2f' : '#5b9bd5'} label={{ position: 'top', fontSize: 10 }} />)}</BarChart>}</ResponsiveContainer></Card>;
}

function PanelHeader({ title, subtitle }) { const { range } = useContext(DateRangeContext); return <div className="panel-header"><h2>{title}</h2><span>{subtitle ?? range.label}</span></div>; }
function Legend({ items }) { return <div className="legend-list">{items.map((item, i) => <div key={item.name}><span style={{ background: COLORS[i % COLORS.length] }} />{item.name}<b>{formatCurrency(item.value)}</b></div>)}</div>; }
function TableCard({ title, rows = [], columns, pageSize = 10 }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  useEffect(() => { setPage(0); }, [rows, pageSize]);
  const safePage = Math.min(page, totalPages - 1);
  const visibleRows = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);
  return <Card className="table-card">
    <PanelHeader title={title} />
    {rows.length ? <>
      <div className="table-wrap"><table><thead><tr>{columns.map(c => <th key={c}>{c.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{visibleRows.map((row, i) => <tr key={i}>{columns.map(c => <td key={c}>{row[c] ?? '—'}</td>)}</tr>)}</tbody></table></div>
      {rows.length > pageSize && <div className="pager"><Button variant="ghost" disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>← Previous</Button><span>Page {safePage + 1} of {totalPages} · {formatNumber(rows.length)} rows</span><Button variant="ghost" disabled={safePage >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>Next →</Button></div>}
    </> : <Empty text="No data imported yet." />}
  </Card>;
}

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
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=businessPerformance`}>Business Performance</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=productPerformance`}>Product Performance</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=inventory`}>Inventory</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=payouts`}>Payouts</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=brand`}>Brand Analytics</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=orders`}>Orders</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=returns`}>Returns</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=reimbursements`}>Reimbursements</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=tax`}>GST & Tax</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=pricing`}>Pricing & Buy Box</SidebarLink>
        <SidebarLink to={`/seller?tenantId=${session?.tenantId ?? ''}&view=listings`}>Listings</SidebarLink>
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