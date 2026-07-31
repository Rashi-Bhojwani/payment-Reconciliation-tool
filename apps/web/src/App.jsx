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
const COLORS = ['#1668e8', '#7c3aed', '#22a65a', '#94a3b8'];

// Maps each report code to a stable CSS class so the Sync Ledger and Reports
// grid can color-code report families (each is a genuinely distinct SP-API
// data domain, so the color carries real information, not just decoration).
const CODE_COLOR_KEY = { API: 'api', STL: 'stl', 'S&T': 'st', B2B: 'b2b', B2C: 'b2c', INV: 'inv', RMB: 'rmb', RTN: 'rtn' };
function codeClass(code) { return `code-${CODE_COLOR_KEY[code] ?? code.toLowerCase().replace(/[^a-z0-9]/gi, '')}`; }

// Which report(s) power each sidebar page. Each page now syncs only what it
// needs instead of showing every report side-by-side everywhere.
// Dashboard is deliberately absent here — it's an overview page and no
// longer shows any sync controls at all. Every other sidebar page gets only
// the report(s) it actually depends on.

const NAV_ITEMS = [
  { view: 'dashboard', label: 'Dashboard', icon: '▦' },
  { view: 'orderPayments', label: 'Order Payments', icon: '₹' },
  { view: 'sales', label: 'Sales Analytics', icon: '↗' },
  { view: 'businessPerformance', label: 'Business Performance', icon: '▤' },
  { view: 'productPerformance', label: 'Product Performance', icon: '◈' },
  { view: 'inventory', label: 'Inventory', icon: '□' },
  { view: 'payouts', label: 'Payouts', icon: '₹' },
  { view: 'brand', label: 'Brand Analytics', icon: '☆' },
  { view: 'feeAudit', label: 'Fee Leak Audit', icon: '!' },
  { view: 'returns', label: 'Returns', icon: '↩' },
  { view: 'reimbursements', label: 'Reimbursements', icon: '+' },
  { view: 'tax', label: 'GST & Tax', icon: '%' },
  { view: 'reports', label: 'Reports', icon: '◎' },
  { view: 'rawData', label: 'Raw API Data', icon: '{}' }
];

const VIEW_REPORT_TYPES = {
  orderPayments: ['DIRECT_SP_API_SYNC', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'],
  sales: ['GET_SALES_AND_TRAFFIC_REPORT'],
  inventory: ['GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'],
  payouts: ['DIRECT_SP_API_SYNC', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'],
  brand: ['DIRECT_SP_API_SYNC'],
  feeAudit: ['DIRECT_SP_API_SYNC'],
  returns: ['GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'],
  reimbursements: ['GET_FBA_REIMBURSEMENTS_DATA'],
  tax: ['GET_GST_MTR_B2B_CUSTOM', 'GET_GST_MTR_B2C_CUSTOM'],
  reports: REPORTS.map(r => r.type),
  businessPerformance: ['GET_SALES_AND_TRAFFIC_REPORT', 'DIRECT_SP_API_SYNC', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'],
  productPerformance: ['GET_SALES_AND_TRAFFIC_REPORT'],
  rawData: REPORTS.map(r => r.type)
};
const VIEW_LEDGER_COPY = {
  orderPayments: { title: 'Real payment data sync', subtitle: 'Orders API + Finances API + final settlement report' },
  sales: { title: 'Sales & traffic sync', subtitle: 'Powers this page only' },
  inventory: { title: 'Inventory sync', subtitle: 'This page only' },
  payouts: { title: 'Payout sync', subtitle: 'Orders, finance and settlements' },
  brand: { title: 'Brand analytics sync', subtitle: 'Orders and item performance' },
  feeAudit: { title: 'Fee data sync', subtitle: 'Sync finance items before running an audit' },
  returns: { title: 'Returns sync', subtitle: 'Customer return report' },
  reimbursements: { title: 'Reimbursements sync', subtitle: 'Amazon credits' },
  tax: { title: 'GST sync', subtitle: 'B2B and B2C invoice reports' },
  reports: { title: 'Sync ledger', subtitle: 'Pull one report at a time' },
  businessPerformance: { title: 'Business performance sync', subtitle: 'Sales, traffic and refunds' },
  productPerformance: { title: 'Product performance sync', subtitle: 'ASIN-level sales and traffic' },
  rawData: { title: 'Raw API sync', subtitle: 'Pull one source at a time to respect limits' }
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
async function syncAmazonSource(tenantId, reportType, range) {
  const payload = { method: 'POST', body: JSON.stringify({ range: { start: formatDateParam(range.start), end: formatDateParam(addDays(range.end, 1)) } }) };
  return api(`/api/tenants/${tenantId}/sync/${reportType}`, payload);
}

function Button({ className = '', variant = 'primary', icon, children, ...props }) { return <button {...props} className={`btn btn-${variant} ${className}`}>{icon && <span className="btn-icon" aria-hidden="true">{icon}</span>}{children}</button>; }
function Input(props) { return <input {...props} className="input" />; }
function Card({ children, className = '' }) { return <section className={`card ${className}`}>{children}</section>; }
function Empty({ text }) { return <div className="empty-state">{text}</div>; }
function formatCurrency(value) { return `₹${Number(value ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
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
//
// Amazon Seller Central always reports "today"/"this week"/a custom date
// range using India Standard Time (IST, UTC+5:30 year-round, no DST) for an
// India marketplace account — this tool's default and primary market. If day
// boundaries were computed in the *browser's* local timezone instead, a
// viewer outside IST would get a range shifted by hours, silently pulling in
// or excluding orders/settlements Seller Central counts on a different
// calendar day. Every "day" computed here is therefore pinned to IST.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const IST_TIME_ZONE = 'Asia/Kolkata';
function istParts(d) {
  const t = new Date(new Date(d).getTime() + IST_OFFSET_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth(), date: t.getUTCDate() };
}
function startOfDay(d) { const { year, month, date } = istParts(d); return new Date(Date.UTC(year, month, date) - IST_OFFSET_MS); }
function addDays(d, n) { return new Date(new Date(d).getTime() + n * 864e5); }
function formatShort(d) { return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', timeZone: IST_TIME_ZONE }); }
function formatDateParam(date) { return startOfDay(date).toISOString(); }
function rangeQuery(range) { return `start=${encodeURIComponent(formatDateParam(range.start))}&end=${encodeURIComponent(formatDateParam(addDays(range.end, 1)))}`; }
function formatRangeLabel(start, end) {
  const startStr = formatShort(start);
  const endStr = istParts(start).year === istParts(end).year ? formatShort(end) : end.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric', timeZone: IST_TIME_ZONE });
  return `${startStr} – ${endStr}, ${istParts(end).year}`;
}
function defaultDateRange() { const end = startOfDay(new Date()); return { label: 'Last 30 Days', start: addDays(end, -29), end }; }
const DateRangeContext = createContext({ range: defaultDateRange(), setRange: () => {} });

function toDateInputValue(date) {
  // Read the IST calendar date directly instead of using local getters
  // (getFullYear/getMonth/getDate), which reflect the browser's timezone and
  // can report the wrong day near midnight for a viewer outside IST.
  const { year, month, date: day } = istParts(date);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function fromDateInputValue(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
}
function DateRangePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => ({ start: toDateInputValue(value.start), end: toDateInputValue(value.end) }));
  const rootRef = useRef(null);

  useEffect(() => {
    setDraft({ start: toDateInputValue(value.start), end: toDateInputValue(value.end) });
  }, [value.start, value.end]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e) { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  function applyRange() {
    const start = fromDateInputValue(draft.start);
    const end = fromDateInputValue(draft.end);
    const ordered = start <= end ? { start, end } : { start: end, end: start };
    onChange({ label: formatRangeLabel(ordered.start, ordered.end), ...ordered });
    setOpen(false);
  }

  return (
    <div className="date-range-picker" ref={rootRef}>
      <button type="button" className="date-range-trigger" onClick={() => setOpen(o => !o)}>
        <span className="date-range-icon">📅</span>{value.label}
      </button>
      {open && (
        <div className="date-range-panel date-range-panel-simple">
          <div className="date-field-group">
            <label>Start date</label>
            <input className="input" type="date" value={draft.start} max={draft.end || toDateInputValue(new Date())} onChange={e => setDraft(d => ({ ...d, start: e.target.value }))} />
          </div>
          <div className="date-field-group">
            <label>End date</label>
            <input className="input" type="date" value={draft.end} min={draft.start} max={toDateInputValue(new Date())} onChange={e => setDraft(d => ({ ...d, end: e.target.value }))} />
          </div>
          <div className="calendar-footer range-apply-row">
            <span className="muted small">Applied only after clicking Apply</span>
            <Button type="button" onClick={applyRange}>Apply</Button>
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
      const result = await syncAmazonSource(tenantId, reportType, range);
      if (result?.status === 'failed') throw new Error(result.error ?? 'Sync failed');
      const failedDirectSync = result?.results?.find?.(row => row.status === 'failed');
      if (failedDirectSync) throw new Error(failedDirectSync.error ?? 'Sync failed');
      const syncResult = result?.results?.[0] ?? result;
      const summary = reportType === 'DIRECT_SP_API_SYNC' ? `${formatNumber(syncResult?.ordersImported)} orders · ${formatNumber(syncResult?.transactionsImported)} finance transactions` : `${formatNumber(syncResult?.rowsImported)} report rows imported`;
      setRowState(s => ({ ...s, [reportType]: { loading: false, justSynced: true, summary } }));
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
          // Only this mounted ledger owns its loading state. A persisted
          // `running` row may belong to an abandoned request, so it must not
          // leave this control disabled after the page is refreshed.
          const busy = local?.loading;
          const failed = local?.error || job?.status === 'failed';
          const statusLabel = disabled ? 'locked' : busy ? 'syncing' : failed ? 'failed' : job?.status ?? 'idle';
          return (
            <div className={`ledger-row ${codeClass(report.code)}`} key={report.type}>
              <span className="ledger-index">{String(i + 1).padStart(2, '0')}</span>
              <span className={`ledger-code ${codeClass(report.code)}`}>{report.code}</span>
              <div className="ledger-meta">
                <b>{report.label}</b>
                <small>{local?.error ?? local?.summary ?? (job?.completed_at ? `Last synced ${timeAgo(job.completed_at)}` : report.hint)}</small>
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
  const view = params.get('view') ?? 'orderPayments';
  const freshAmazonAuth = params.get('auth') === 'complete';
  const amazonError = params.get('amazon') === 'error' ? (params.get('message') ?? 'Amazon authorization failed') : '';
  const { range } = useContext(DateRangeContext);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const rangeSyncRef = useRef({ key: '', requestId: 0 });
  async function load(targetRange = range, requestId = rangeSyncRef.current.requestId) {
    setError('');
    try {
      const dashboard = await api(`/api/tenants/${tenantId}/dashboard?${rangeQuery(targetRange)}`);
      if (requestId === rangeSyncRef.current.requestId) setData(dashboard);
    } catch (e) {
      if (requestId === rangeSyncRef.current.requestId) setError(e.message);
    }
  }
  useEffect(() => {
    if (!tenantId) return;
    rangeSyncRef.current.requestId += 1;
    void load(range, rangeSyncRef.current.requestId);
  }, [tenantId, range.start, range.end]);

  // Pulled from the same calculateDashboardMetrics engine that powers every
  // other KPI on this dashboard, so this chart can never disagree with the
  // Net Sales / Deductions / Settled figures shown elsewhere on the page.
  const channelData = useMemo(() => {
    const calculated = data?.dashboardCalculations?.metrics;
    return [
      { name: 'Net Sales', value: Number(calculated?.netSales?.value ?? 0) },
      { name: 'Deductions', value: Math.abs(Number(calculated?.deductions?.value ?? 0)) },
      { name: 'Settled Amount', value: Number(calculated?.settled?.value ?? 0) }
    ].filter(item => item.value > 0);
  }, [data]);
  const reportTypes = VIEW_REPORT_TYPES[view];
  const ledgerCopy = VIEW_LEDGER_COPY[view];
  const detailView = view === 'report-detail' || view === 'metric-detail';
  const connected = !!data?.seller?.connected;

  return <div className="page-stack">
    <div className="section-title">
      <div><h1>{viewTitle(view)}</h1><p>{viewDescription(view)}</p></div>
      <div className="actions">
        <AmazonConnectionPanel tenantId={tenantId} seller={data?.seller} onChange={load} setError={setError} />
      </div>
    </div>
    {freshAmazonAuth && connected && <p className="alert success">Amazon account connected. Select a date range or use Sync on this page to pull limited data.</p>}
    {amazonError && <p className="alert warning">Amazon connection issue: {amazonError}</p>}
    {error && <p className="alert warning">{error}</p>}
    {(view === 'dashboard' || view === 'orderPayments') && !connected && data && <p className="alert warning">Connect your Amazon account to start pulling real payment data — nothing syncs until then.</p>}
    {view !== 'dashboard' && !detailView && <SyncLedger tenantId={tenantId} jobs={data?.jobs ?? []} onSynced={load} reportTypes={reportTypes} title={ledgerCopy?.title} subtitle={ledgerCopy?.subtitle} disabled={!connected} />}

    {view === 'orderPayments' && <OrderReconciliation tenantId={tenantId} />}
    {view === 'dashboard' && <DashboardOverview data={data} channelData={channelData} tenantId={tenantId} />}
    {view === 'sales' && <SalesAnalytics data={data} channelData={channelData} />}
    {view === 'businessPerformance' && <BusinessPerformanceReport data={data} />}
    {view === 'productPerformance' && <ProductPerformanceReport data={data} />}
    {view === 'inventory' && <TableCard title="Inventory" rows={data?.inventory ?? []} columns={['sku', 'fulfillable_quantity', 'snapshot_date']} />}
    {view === 'payouts' && <TableCard title="Payout Activity" rows={data?.payments ?? []} columns={['posted_date', 'settlement_id', 'net_amount', 'lines']} />}
    {view === 'brand' && <TableCard title="Product Performance" rows={data?.products ?? []} columns={['asin', 'units', 'sales', 'buy_box']} />}
    {view === 'feeAudit' && <FeeLeakAudit tenantId={tenantId} />}
    {view === 'returns' && <TableCard title="Return Details" rows={data?.returns ?? []} columns={['order_id', 'return_reason', 'disposition', 'status', 'return_date']} />}
    {view === 'reimbursements' && <TableCard title="Reimbursement Details" rows={data?.reimbursements ?? []} columns={['sku', 'amount', 'reason', 'reimbursement_date']} />}
    {view === 'tax' && <TableCard title="GST Invoice Details" rows={data?.invoices ?? []} columns={['invoice_type', 'order_id', 'taxable_value', 'cgst', 'sgst', 'igst', 'invoice_date']} />}
    {view === 'reports' && <ReportsExplorer tenantId={tenantId} data={data} />}
    {view === 'rawData' && <RawApiDataExplorer data={data} />}
    {view === 'report-detail' && <ReportDetail data={data} reportType={params.get('reportType')} />}
    {view === 'metric-detail' && <MetricDetail metric={params.get('metric')} tenantId={tenantId} />}
  </div>;
}

function viewTitle(view) { return ({ orderPayments: 'Order Payment Reconciliation', dashboard: 'Dashboard', sales: 'Sales Analytics', businessPerformance: 'Business Performance', productPerformance: 'Product Performance', inventory: 'Inventory', payouts: 'Payout Reconciliation', brand: 'Brand Analytics', feeAudit: 'Fee Leak Audit', returns: 'Returns', reimbursements: 'Reimbursements', tax: 'GST & Tax', reports: 'Reports', rawData: 'Raw API Data', 'report-detail': 'Report Detail', 'metric-detail': 'Calculation Detail' })[view] ?? 'Dashboard'; }
function viewDescription(view) { return ({ orderPayments: 'See every rupee from customer order value, through Amazon deductions, to the final FBA or FBM seller receivable.', dashboard: 'Amazon-only reconciliation KPIs with explainable drill-downs.', sales: 'Revenue, order value, units and product sales trends from Amazon reports.', businessPerformance: 'Excel-style quarterly business performance report with analysed KPIs and matching graphs.', productPerformance: 'Excel-style product performance analysis with top products and written insights.', inventory: 'FBA inventory snapshots imported from SP-API inventory reports.', payouts: 'Settlement rows and payout reconciliation from Amazon settlement reports.', brand: 'ASIN-level product performance from synced Amazon order items, with Sales & Traffic metrics when available.', returns: 'Customer return reasons, status and disposition.', reimbursements: 'Amazon reimbursement credits for lost, damaged or adjusted inventory.', tax: 'GST B2B and B2C invoice rows in readable form.', reports: 'Open each fetched report and view human-readable data.', rawData: 'Inspect raw fields returned from each imported API/report source before finalizing calculations.', 'report-detail': 'Human-readable rows from the selected SP-API report.' })[view] ?? 'Live seller KPIs populated from synced SP-API orders and reports.'; }

function OrderPayments({ data }) {
  const rows = data?.orderPayments ?? [];
  const summary = data?.paymentSummary ?? {};
  const displayed = rows.map(row => ({
    ...row,
    gross_sales: formatCurrency(row.gross_sales),
    referral_fee: formatCurrency(row.referral_fee),
    fulfillment_fee: formatCurrency(row.fulfillment_fee),
    shipping_and_tax: formatCurrency(row.shipping_and_tax),
    refunds: formatCurrency(row.refunds),
    other_deductions: formatCurrency(row.other_deductions),
    total_deductions: formatCurrency(row.total_deductions),
    seller_receivable: formatCurrency(row.seller_receivable)
  }));
  const deductions = (data?.paymentComponents ?? []).map(row => ({ ...row, amount: formatCurrency(row.amount) }));
  return <>
    <Card className="money-flow-card">
      <div className="money-flow-heading"><div><span className="live-source">LIVE AMAZON SOURCES</span><h2>Where the order money goes</h2></div><p>Final settlements take priority over interim Finance events, so the same transaction is never counted twice.</p></div>
      <div className="money-flow">
        <div><small>Customer order value</small><strong>{formatCurrency(summary.grossSales)}</strong><span>Orders API</span></div>
        <b>−</b><div className="deduction-step"><small>Amazon deductions</small><strong>{formatCurrency(summary.deductions)}</strong><span>Fees · tax · refunds</span></div>
        <b>=</b><div className="receivable-step"><small>Seller receives</small><strong>{formatCurrency(summary.sellerReceivable)}</strong><span>Settlement / Finances API</span></div>
      </div>
      <div className="fulfillment-split"><div><span>FBA received</span><strong>{formatCurrency(summary.fbaReceivable)}</strong><small>Amazon fulfilled</small></div><div><span>FBM received</span><strong>{formatCurrency(summary.fbmReceivable)}</strong><small>Merchant fulfilled</small></div><div><span>Unclassified</span><strong>{formatCurrency(summary.otherReceivable)}</strong><small>Pending channel data</small></div></div>
    </Card>
    <TableCard title="Order-by-order money trail" rows={displayed} columns={['amazon_order_id', 'product', 'sku', 'fulfillment', 'package_weight', 'package_dimensions', 'gross_sales', 'referral_fee', 'fulfillment_fee', 'shipping_and_tax', 'refunds', 'other_deductions', 'total_deductions', 'seller_receivable', 'payment_status', 'source']} pageSize={10} />
    <TableCard title="Every Amazon money component" rows={deductions} columns={['amazon_order_id', 'product', 'asin', 'sku', 'fulfillment', 'package_weight', 'package_dimensions', 'posted_date', 'category', 'deduction', 'amount', 'source']} pageSize={12} />
    {!rows.length && <p className="alert warning">No order payment rows are available for this period. Connect Amazon, then run the real payment data sync above.</p>}
  </>;
}
const MONEY_LABELS = {
  referral_commission: 'Referral commission', fulfillment_fee_per_order: 'FBA fulfillment fee', fulfillment_fee_per_unit: 'FBA per-unit fee', fulfillment_fee_weight: 'FBA weight handling',
  closing_fee: 'Closing fee', shipping_fee: 'Shipping service fee', storage_fee: 'Storage fee', digital_services_fee: 'Digital services fee', tax: 'Tax / withholding',
  promotion: 'Promotional rebate', shipping_charge: 'Shipping paid by customer', gift_wrap: 'Gift wrap paid by customer', refund: 'Customer refund', reimbursement: 'Amazon reimbursement', adjustment: 'Amazon adjustment', other: 'Other Amazon movement'
};
function friendlyMoneyLabel(row) { return MONEY_LABELS[row.category] ?? String(row.amount_description ?? row.category).replaceAll('_', ' '); }
function OrderMoneyDetails({ order, detail }) {
  const leafLines = detail.fees.filter(row => !String(row.category).startsWith('summary_'));
  const deductions = leafLines.filter(row => Number(row.amount) < 0 && !['promotion', 'refund'].includes(row.category));
  const additions = leafLines.filter(row => Number(row.amount) > 0 && row.category !== 'item_price');
  return <div className="money-explainer">
    <h4>Your money journey</h4>
    <div className="journey-cards"><div><small>1 · Customer paid</small><strong>{formatCurrency(order.gross_item_price)}</strong></div><b>−</b><div className="journey-fees"><small>2 · Amazon deducted</small><strong>{formatCurrency(order.total_deductions)}</strong></div><b>+</b><div><small>3 · Tax, credits &amp; other</small><strong>{formatCurrency(order.other_amount)}</strong></div><b>=</b><div className="journey-net"><small>4 · You receive</small><strong>{formatCurrency(order.net_payout)}</strong></div></div>
    <p className="plain-explanation">Amazon started with <b>{formatCurrency(order.gross_item_price)}</b>, deducted <b>{formatCurrency(order.total_deductions)}</b> in fees, applied <b>{formatCurrency(order.other_amount)}</b> in taxes/credits/other movements, and posted <b>{formatCurrency(order.net_payout)}</b> to this transaction.</p>
    <div className="understand-grid"><div><h5>Where Amazon deducted money</h5>{deductions.length?deductions.map((fee,index)=><div className="friendly-line deduction" key={index}><span>{friendlyMoneyLabel(fee)}</span><strong>−{formatCurrency(Math.abs(Number(fee.amount)))}</strong></div>):<p className="muted">No individual deduction lines were returned.</p>}</div><div><h5>Credits, tax and other movements</h5>{additions.length?additions.map((fee,index)=><div className="friendly-line" key={index}><span>{friendlyMoneyLabel(fee)}</span><strong>+{formatCurrency(fee.amount)}</strong></div>):<p className="muted">No positive adjustments were returned.</p>}</div></div>
    <details className="source-lines"><summary>Show Amazon source lines ({formatNumber(leafLines.length)})</summary>{leafLines.map((fee,index)=><div className={Number(fee.amount)<0?'fee-line negative':'fee-line'} key={index}><span>{fee.amount_description||fee.category}</span><small>{fee.category}</small><strong>{formatCurrency(fee.amount)}</strong></div>)}</details>
  </div>;
}
function OrderReconciliation({ tenantId }) {
  const { range } = useContext(DateRangeContext);
  const [orders, setOrders] = useState([]); const [transactions,setTransactions]=useState([]); const [source,setSource]=useState(''); const [flags, setFlags] = useState([]); const [openId, setOpenId] = useState(''); const [details, setDetails] = useState({}); const [error, setError] = useState('');
  const [orderSearch,setOrderSearch]=useState(''); const [orderView,setOrderView]=useState('matched'); const [orderPage,setOrderPage]=useState(0); const [ledgerFilters,setLedgerFilters]=useState({account:'',type:'',status:'',orderId:''});
  useEffect(() => { let active=true; setError(''); Promise.all([api(`/api/tenants/${tenantId}/orders-reconciliation?${rangeQuery(range)}`),api(`/api/tenants/${tenantId}/transactions?${rangeQuery(range)}`),api(`/api/tenants/${tenantId}/fee-leaks?${rangeQuery(range)}`)]).then(([result,ledger,leaks])=>{if(active){setOrders(result.orders);setTransactions(ledger.transactions);setSource(result.source);setFlags(leaks.flags);}}).catch(e=>{if(active)setError(e.message)}); return()=>{active=false}; },[tenantId,range.start,range.end]);
  async function toggle(orderId) { if(openId===orderId){setOpenId('');return;} setOpenId(orderId); if(!details[orderId]) { try { const detail=await api(`/api/tenants/${tenantId}/orders-reconciliation/${encodeURIComponent(orderId)}`); setDetails(value=>({...value,[orderId]:detail})); } catch(e){setError(e.message);} } }
  const flagByOrder=new Map(flags.map(flag=>[flag.order_id,flag]));
  const counts = { reconciled: orders.filter(order=>order.hasFeeData).length, awaiting: orders.filter(order=>!order.hasFeeData&&!/cancel/i.test(order.status??'')).length, cancelled: orders.filter(order=>/cancel/i.test(order.status??'')).length };
  const filteredOrders=orders.filter(order=>(orderView==='all'||(orderView==='matched'&&order.hasFeeData)||(orderView==='awaiting'&&!order.hasFeeData&&!/cancel/i.test(order.status??''))||(orderView==='cancelled'&&/cancel/i.test(order.status??'')))&&String(order.amazon_order_id).toLowerCase().includes(orderSearch.trim().toLowerCase()));
  const orderPageSize=10; const orderTotalPages=Math.max(1,Math.ceil(filteredOrders.length/orderPageSize)); const safeOrderPage=Math.min(orderPage,orderTotalPages-1); const visibleOrders=filteredOrders.slice(safeOrderPage*orderPageSize,safeOrderPage*orderPageSize+orderPageSize);
  useEffect(()=>setOrderPage(0),[orderView,orderSearch,range.start,range.end]);
  const uniqueValues=key=>[...new Set(transactions.map(row=>row[key]).filter(Boolean))].sort();
  const filteredTransactions=transactions.filter(row=>(!ledgerFilters.account||row.account_type===ledgerFilters.account)&&(!ledgerFilters.type||row.transaction_type===ledgerFilters.type)&&(!ledgerFilters.status||row.transaction_status===ledgerFilters.status)&&String(row.order_id??'').toLowerCase().includes(ledgerFilters.orderId.trim().toLowerCase()));
  function statusBadge(order, flag) {
    if (flag) return <span className="overcharge-badge">Overcharged {formatCurrency(flag.variance)}</span>;
    if (order.hasFeeData) return <span className="pill status-completed">Payment matched</span>;
    if (/cancel/i.test(order.status??'')) return <span className="pill status-idle">Cancelled · no payout</span>;
    if (/pending|unshipped/i.test(order.status??'')) return <span className="pill status-idle">Not shipped yet</span>;
    return <span className="pill status-idle">Awaiting Amazon payment</span>;
  }
  const payoutTime=order=>{
    const raw=String(order.payout_date_time??''); if(!raw) return '—';
    const reportMatch=raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/);
    const parsed=reportMatch?new Date(Date.UTC(Number(reportMatch[3]),Number(reportMatch[2])-1,Number(reportMatch[1]),Number(reportMatch[4]??0),Number(reportMatch[5]??0),Number(reportMatch[6]??0))):new Date(raw);
    return Number.isNaN(parsed.getTime())?raw:new Intl.DateTimeFormat('en-GB',{
      day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZone:'UTC',timeZoneName:'short'
    }).format(parsed);
  };
  const reconciliationTable = <Card className="table-card"><PanelHeader title="Order-wise gross → fees → payout" subtitle={source||'Loading Amazon money lines'} /><div className="reconciliation-summary"><button type="button" className={orderView==='matched'?'active':''} onClick={()=>setOrderView('matched')}><strong>{formatNumber(counts.reconciled)}</strong><span>Payments posted in this period</span></button><button type="button" className={orderView==='awaiting'?'active':''} onClick={()=>setOrderView('awaiting')}><strong>{formatNumber(counts.awaiting)}</strong><span>Recent orders awaiting Amazon</span></button><button type="button" className={orderView==='cancelled'?'active':''} onClick={()=>setOrderView('cancelled')}><strong>{formatNumber(counts.cancelled)}</strong><span>Cancelled — no payout expected</span></button><button type="button" className={orderView==='all'?'active':''} onClick={()=>setOrderView('all')}><strong>{formatNumber(orders.length)}</strong><span>All orders</span></button></div><p className="reconciliation-note">The payout columns use the Finances API transaction status and posted timestamp. Settlement ID and deposit-date data come from Amazon's settlement report. “Yes” means Amazon released or initiated the payout; SP-API cannot confirm when the seller's bank actually credited it.</p><div className="order-search"><Input value={orderSearch} onChange={event=>setOrderSearch(event.target.value)} placeholder="Search order ID…"/><span>{formatNumber(filteredOrders.length)} matching orders</span></div>{error&&<p className="alert error">{error}</p>}{filteredOrders.length?<><div className="table-wrap"><table><thead><tr>{['Order','Settlement ID','Amazon status','Transaction date','Product charges','Promotions','Referral','Fulfillment','Amazon fees','Other','Net payout','Money released?','Released / deposit time','Payout status','Reconciliation',''].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{visibleOrders.map(order=>{const flag=flagByOrder.get(order.amazon_order_id);const detail=details[order.amazon_order_id];return <React.Fragment key={order.amazon_order_id}><tr><td>{order.amazon_order_id}</td><td>{order.settlement_id??'—'}</td><td>{order.status??'—'}</td><td>{String(order.transaction_date??order.order_date??'').slice(0,10)}</td><td>{Number(order.gross_item_price)?formatCurrency(order.gross_item_price):'Items pending'}</td><td>{order.hasFeeData?formatCurrency(order.promotion):'—'}</td><td>{order.hasFeeData?formatCurrency(order.referral_commission):'—'}</td><td>{order.hasFeeData?formatCurrency(order.fulfillment_fee):'—'}</td><td>{order.hasFeeData?formatCurrency(order.total_deductions):'—'}</td><td>{order.hasFeeData?formatCurrency(order.other_amount):'—'}</td><td><b>{order.hasFeeData?formatCurrency(order.net_payout):'—'}</b></td><td><span className={`pill ${order.payment_received?'status-completed':'status-idle'}`}>{order.payment_received?'Yes':'No'}</span></td><td>{payoutTime(order)}</td><td>{order.payout_status??'Awaiting payment data'}</td><td>{statusBadge(order,flag)}</td><td><Button variant="ghost" onClick={()=>toggle(order.amazon_order_id)}>{openId===order.amazon_order_id?'Hide':'Details'}</Button></td></tr>{openId===order.amazon_order_id&&<tr className="order-detail-row"><td colSpan="16">{detail?<div className="order-detail-grid"><div><h4>Items</h4>{detail.items.length?detail.items.map((item,index)=><p key={index}><b>{item.title}</b><br/>{item.sku} · {formatNumber(item.quantity_ordered)} × {formatCurrency(item.item_price)}{item.package_weight?` · ${item.package_weight} ${item.weight_unit??''}`:''}</p>):<p className="muted">Order items have not been returned by Amazon yet. Run Orders & finance sync again after the order is confirmed.</p>}</div><OrderMoneyDetails order={order} detail={detail} /></div>:<Empty text="Loading order details…" />}</td></tr>}</React.Fragment>})}</tbody></table></div>{orderTotalPages>1&&<div className="pager"><Button variant="ghost" disabled={safeOrderPage===0} onClick={()=>setOrderPage(page=>Math.max(0,page-1))}>← Previous</Button><span>Page {safeOrderPage+1} of {orderTotalPages} · {formatNumber(filteredOrders.length)} orders</span><Button variant="ghost" disabled={safeOrderPage>=orderTotalPages-1} onClick={()=>setOrderPage(page=>Math.min(orderTotalPages-1,page+1))}>Next →</Button></div>}</>:<Empty text="No synced orders in this period."/>}</Card>;
  const ledgerColumns=['posted_date','transaction_status','account_type','transaction_type','order_id','product_details','product_charges','promotional_rebates','amazon_fees','other','total'];
  const ledgerRows=filteredTransactions.map(row=>({...row,posted_date:String(row.posted_date??'').slice(0,10),product_charges:formatCurrency(row.product_charges),promotional_rebates:formatCurrency(row.promotional_rebates),amazon_fees:formatCurrency(row.amazon_fees),other:formatCurrency(row.other),total:formatCurrency(row.total)}));
  return <>{reconciliationTable}<Card className="transaction-ledger-intro"><div><span className="live-source">MATCHES SELLER CENTRAL TRANSACTION VIEW</span><h2>All Amazon transactions</h2><p>This includes Order Payments, refunds, Easy Ship charges, service fees, tax withheld, and standalone transactions—not only orders that have a payout.</p></div><div className="transaction-ledger-actions"><strong>{formatNumber(filteredTransactions.length)} of {formatNumber(transactions.length)} transactions</strong><Button variant="secondary" disabled={!ledgerRows.length} onClick={()=>downloadCsv('amazon-transactions.csv',ledgerRows,ledgerColumns)}>Download filtered CSV</Button></div></Card><Card className="transaction-filters"><div><label>Account type<select className="input" value={ledgerFilters.account} onChange={event=>setLedgerFilters(value=>({...value,account:event.target.value}))}><option value="">All account types</option>{uniqueValues('account_type').map(value=><option key={value}>{value}</option>)}</select></label><label>Transaction type<select className="input" value={ledgerFilters.type} onChange={event=>setLedgerFilters(value=>({...value,type:event.target.value}))}><option value="">All transaction types</option>{uniqueValues('transaction_type').map(value=><option key={value}>{value}</option>)}</select></label><label>Transaction status<select className="input" value={ledgerFilters.status} onChange={event=>setLedgerFilters(value=>({...value,status:event.target.value}))}><option value="">All statuses</option>{uniqueValues('transaction_status').map(value=><option key={value}>{value}</option>)}</select></label><label>Order ID<Input value={ledgerFilters.orderId} onChange={event=>setLedgerFilters(value=>({...value,orderId:event.target.value}))} placeholder="Enter order ID…"/></label></div><Button variant="ghost" onClick={()=>setLedgerFilters({account:'',type:'',status:'',orderId:''})}>Clear filters</Button></Card><TableCard title="Complete Amazon transaction ledger" rows={ledgerRows} columns={ledgerColumns} pageSize={10}/></>;
}

function FeeLeakAudit({tenantId}) {
  const {range}=useContext(DateRangeContext); const [result,setResult]=useState({flags:[],totalOvercharged:0}); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  async function load(){setResult(await api(`/api/tenants/${tenantId}/fee-leaks?${rangeQuery(range)}`));}
  useEffect(()=>{load().catch(e=>setError(e.message));},[tenantId,range.start,range.end]);
  async function audit(){setBusy(true);setError('');try{await api(`/api/tenants/${tenantId}/fee-audit`,{method:'POST',body:JSON.stringify({range:{start:formatDateParam(range.start),end:formatDateParam(addDays(range.end,1))},varianceThreshold:5})});await load();}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <><Card className="fee-audit-hero"><div><span className="live-source">AMAZON FEES ESTIMATE API</span><h2>{formatCurrency(result.totalOvercharged)} potential overcharge</h2><p>Expected Amazon fees compared with itemized fees actually deducted. Slab fallback is clearly identified when used.</p></div><Button onClick={audit} disabled={busy}>{busy?'Auditing…':'Run fee audit'}</Button></Card>{error&&<p className="alert error">{error}</p>}<TableCard title="Flagged fee discrepancies" rows={result.flags} columns={['order_id','sku','source','expected_fee','actual_fee','variance','flagged_at','resolved']} pageSize={15}/></>;
}
function DashboardOverview({ data, channelData, tenantId }) {
  const { range } = useContext(DateRangeContext);
  const summary = useMemo(() => buildDashboardSummary(data, range), [data, range]);
  return <>
    <div className="metrics-strip">
      <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=netSales`} title="Net Sales" value={formatCurrency(summary.netSales)} hint="Click to see order-value formula" />
      <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=netQty`} title="Net Qty" value={summary.netQty==null?'Unavailable':formatNumber(summary.netQty)} hint="Click to see units source" />
      <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=orders`} title="Orders Synced" value={formatNumber(summary.ordersCount)} hint="Distinct eligible Amazon order IDs" />
      <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=returns`} title="Returns" value={formatNumber(summary.returnQty)} hint="Total returned quantity" />
    </div>

    <Card className="profit-control-card">
      <PanelHeader title="Profit Analysis" subtitle="Clean overview" />
      <div className="profit-kpi-grid">
        <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=settled`} title="Settled Amount" value={formatCurrency(summary.settledAmount)} hint="From settlements / finance" />
        <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=deductions`} title="Deductions" value={formatCurrency(summary.deductions)} hint="Fees, refunds, charges" />
        <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=reimbursements`} title="Reimbursements" value={formatCurrency(summary.reimbursements)} hint="Credits imported" />
        <DrillMetric to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=drr`} title="DRR" value={formatCurrency(summary.drr)} hint="Daily run rate" />
      </div>
    </Card>

    <ExplanationGrid summary={summary} tenantId={tenantId} />

    <Card className="profit-control-card">
      <PanelHeader title="Amazon Account Activity" subtitle="Matches Amazon statement sections" />
      <div className="profit-kpi-grid account-activity-grid">
        {['income','expenses','tax','transfers','gst'].map(metric=><DrillMetric key={metric} to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=${metric}`} title={metric==='gst'?'Goods and Services Tax':metric[0].toUpperCase()+metric.slice(1)} value={formatCurrency(data?.dashboardCalculations?.statement?.[metric]?.value)} hint="Open Amazon source rows and formula" />)}
      </div>
    </Card>

    <SalesAnalytics data={data} channelData={channelData} />

    <div className="dashboard-grid two">
      <TableCard title="Reconciliation Snapshot" rows={summary.reconcileRows} columns={['area', 'count', 'amount', 'status']} />
      <TableCard title="Recent Sync Jobs" rows={data?.jobs ?? []} columns={['report_type', 'status', 'completed_at', 'error_message']} />
    </div>
  </>;
}


function DrillMetric({ to, title, value, hint }) { return <NavLink to={to} className="mini-metric drill-metric"><span>{title}</span><strong>{value}</strong>{trendHint(hint)}<em>View calculation →</em></NavLink>; }
function ExplanationGrid({ summary, tenantId }) {
  const cards = [
    ['Fee impact', summary.feeImpact==null?'Unavailable':`${Number(summary.feeImpact).toLocaleString('en-IN',{maximumFractionDigits:2})}%`, 'Net Amazon fees excluding TCS/TDS as a percentage of gross product sales.', 'feeImpact'],
    ['Return rate', summary.returnRate==null?'Unavailable / source mismatch':`${Number(summary.returnRate).toLocaleString('en-IN',{maximumFractionDigits:2})}%`, 'Physically returned units divided by shipped units.', 'returnRate'],
    ['Refund value rate', summary.refundValueRate==null?'Unavailable':`${Number(summary.refundValueRate).toLocaleString('en-IN',{maximumFractionDigits:2})}%`, 'Product refund value divided by gross product sales; separate from unit return rate.', 'refundValueRate'],
    ['GST invoice value', summary.gstValue==null?'Unavailable':formatCurrency(summary.gstValue), 'Sales-invoice taxable value minus credit-note/refund taxable value.', 'gstValue']
  ];
  return <div className="explain-grid">{cards.map(([title, value, copy, target]) => <NavLink key={title} to={`/seller?tenantId=${tenantId}&view=metric-detail&metric=${target}`} className="explain-card"><b>{title}</b><strong>{value}</strong><p>{copy}</p><span>Open calculation →</span></NavLink>)}</div>;
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
    return <NavLink className={`report-tile ${codeClass(report.code)}`} key={report.type} to={`/seller?tenantId=${tenantId}&view=report-detail&reportType=${report.type}`}>
      <span className={`ledger-code ${codeClass(report.code)}`}>{report.code}</span><div><b>{report.label}</b><p>{detail.explanation}</p></div><small>{job?.completed_at ? `Last synced ${timeAgo(job.completed_at)}` : report.hint}</small>
    </NavLink>;
  })}</div>;
}
function reportFieldCount(rows) { return Array.from(new Set(rows.flatMap(row => Object.keys(row ?? {})))).length; }
function RawApiDataExplorer({ data }) {
  const [activeType, setActiveType] = useState(REPORTS[0].type);
  const [page, setPage] = useState(0);
  const activeReport = REPORTS.find(report => report.type === activeType) ?? REPORTS[0];
  const rows = getReportRows(data, activeReport.type);
  const fields = Array.from(new Set(rows.flatMap(row => Object.keys(row ?? {}))));
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const previewRows = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);
  useEffect(() => { setPage(0); }, [activeType]);
  return <Card className="raw-data-card">
    <PanelHeader title="Raw API data explorer" subtitle="rate-limited source review" />
    <p className="muted">Select one API/report source at a time. The sync ledger above keeps pulls source-by-source instead of fanning out all APIs together, which helps avoid rate-limit pressure.</p>
    <div className="raw-source-tabs">{REPORTS.map(report => {
      const reportRows = getReportRows(data, report.type);
      return <button type="button" key={report.type} className={report.type === activeType ? 'active' : ''} onClick={() => setActiveType(report.type)}><span className={`ledger-code ${codeClass(report.code)}`}>{report.code}</span><b>{report.label}</b><small>{formatNumber(reportRows.length)} rows · {formatNumber(reportFieldCount(reportRows))} fields</small></button>;
    })}</div>
    {rows.length ? <>
      <div className="raw-data-toolbar"><b>{activeReport.label}</b><span>{formatNumber(rows.length)} rows · {formatNumber(fields.length)} fields · showing {formatNumber(previewRows.length)} at a time</span></div>
      <pre className="raw-json-preview">{JSON.stringify(previewRows, null, 2)}</pre>
      {rows.length > pageSize && <div className="pager"><Button variant="ghost" disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>← Previous 6</Button><span>Page {safePage + 1} of {totalPages} · {formatNumber(rows.length)} rows</span><Button variant="ghost" disabled={safePage >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>Next 6 →</Button></div>}
    </> : <Empty text="No raw rows available for this source yet. Use the source-specific Sync button above first." />}
  </Card>;
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
    <TableCard title={`${report.label} rows`} rows={rows} columns={detail.columns} pageSize={6} />
  </>;
}

function componentAmount(data, categories) {
  const summary = data?.financialSummary ?? {};
  return categories.reduce((sum, category) => sum + Number(summary[category] ?? 0), 0);
}
function hasFinancialComponents(data) { return (data?.financialComponents ?? []).length > 0; }
function amazonBusinessReportRows(data) { return data?.businessReportRows ?? []; }
function amazonNetSales(data) {
  const businessSales = amazonBusinessReportRows(data).reduce((sum, row) => sum + Number(row.ordered_product_sales ?? 0), 0);
  if (businessSales) return businessSales;
  const productSales = (data?.products ?? []).reduce((sum, product) => sum + Number(product.sales ?? 0), 0);
  if (productSales) return productSales;
  const itemSales = (data?.orderItems ?? []).reduce((sum, item) => sum + Number(item.item_price ?? 0) - Number(item.promotion_discount ?? 0), 0);
  return itemSales || Number(data?.orders?.order_value ?? 0);
}
function amazonDeductions(data) {
  if (hasFinancialComponents(data)) return Math.abs(componentAmount(data, ['commission', 'fba_fee', 'other_fee', 'tax', 'shipping_tax', 'gift_wrap_tax']));
  return Math.abs(Number(data?.kpis?.deductions ?? 0));
}
function formulaTreeRows(rows) { return rows.map(([label, amount, sign, source]) => ({ component: label, sign, amount, source })); }
function FormulaTree({ rows, total }) {
  return <div className="calculation-tree"><div className="tree-total"><span>Total</span><strong>{formatCurrency(total)}</strong></div>{rows.map(row => <div className="tree-row" key={row.component}><span>{row.sign}</span><b>{row.component}</b><strong>{formatCurrency(row.amount)}</strong><small>{row.source}</small></div>)}</div>;
}

function moneyRows(rows, mapper) { return rows.map((row, index) => ({ line: index + 1, ...mapper(row) })); }
function sumRows(rows, key) { return rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0); }
function MetricDetail({ metric, tenantId }) {
  const { range } = useContext(DateRangeContext);
  const navigate = useNavigate();
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setDetails(null); setError('');
    api(`/api/tenants/${tenantId}/calculations/${metric}?${rangeQuery(range)}`).then(result => { if (active) setDetails(result); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [tenantId, metric, range.start, range.end]);
  if (error) return <p className="alert error">{error}</p>;
  if (!details) return <Empty text="Loading real calculation rows…" />;
  const deductionCategories = new Set(['referral_commission','fulfillment_fee_per_order','fulfillment_fee_per_unit','fulfillment_fee_weight','shipping_fee','storage_fee','chargeback','tax','promotion']);
  return <>
    <Card className="detail-hero">
      <PanelHeader title={String(metric).replace(/([A-Z])/g, ' $1').trim()} subtitle={details.status??(details.unit==='percentage'?`${formatNumber(details.total)}%`:details.unit==='quantity'?formatNumber(details.total):formatCurrency(details.total))} />
      <p className="detail-note"><b>Selected range:</b> {String(details.range?.start??range.start)} → {String(details.range?.end??range.end)} (end exclusive)<br/><b>Source:</b> {details.source}<br/><b>Formula:</b> {details.formula}.</p>
      <div className="calculation-components">{details.components.map(component => <div key={component.category} className={deductionCategories.has(component.category) ? 'negative' : ''}><span>{component.operation} {component.label}</span><small>{formatNumber(component.count)} source rows</small><strong>{component.amount==null?'Unavailable':details.unit==='quantity'||component.category==='days'?formatNumber(component.amount):formatCurrency(component.amount)}</strong></div>)}<div className="total"><span>Total ({details.unit})</span><strong>{details.status??(details.unit==='percentage'?`${formatNumber(details.total)}%`:details.unit==='quantity'?formatNumber(details.total):formatCurrency(details.total))}</strong></div></div>
      <div className="detail-note"><b>Reconciliation diagnostics:</b> {formatNumber(details.diagnostics?.includedRows)} included · {formatNumber(details.diagnostics?.excludedRows)} excluded by source precedence · {formatNumber(details.diagnostics?.duplicateRows)} duplicates removed.</div>
      <div className="detail-actions"><Button variant="secondary" onClick={() => navigate(`/seller?tenantId=${tenantId}&view=dashboard`)}>← Back</Button><Button variant="accent" onClick={() => downloadCsv(`${metric}-calculation.csv`, details.rows, details.columns)} disabled={!details.rows.length}>Download calculation CSV</Button></div>
    </Card>
    <TableCard title="Actual database rows used" rows={details.rows} columns={details.columns} pageSize={10} />
  </>;
}
function buildDashboardSummary(data, range = defaultDateRange()) {
  const calculated=data?.dashboardCalculations?.metrics;
  const products = data?.products ?? [];
  const returns = data?.returns ?? [];
  const payments = data?.payments ?? [];
  const reimbursements = data?.reimbursements ?? [];
  const invoices = data?.invoices ?? [];
  const orderItems = data?.orderItems ?? [];
  const ordersCount = Number(calculated?.orders?.value??data?.orders?.orders??0);
  const netSales = Number(calculated?.netSales?.value??amazonNetSales(data));
  const netQty = calculated?.netQty ? calculated.netQty.value : (products.reduce((sum, product) => sum + Number(product.units ?? 0), 0) || orderItems.reduce((sum, item) => sum + Number(item.quantity_ordered ?? 0), 0));
  const returnQty = Number(calculated?.returns?.value??returns.length);
  const settledAmount = Number(calculated?.settled?.value??(payments.reduce((sum, payment) => sum + Number(payment.net_amount ?? 0), 0) || Number(data?.kpis?.net_settled??0)));
  const deductions = Number(calculated?.deductions?.value??amazonDeductions(data));
  const reimbursementAmount = Number(calculated?.reimbursements?.value??reimbursements.reduce((sum, row) => sum + Number(row.amount ?? 0), 0));
  const estimatedProfit = settledAmount || Math.max(0, netSales - deductions + reimbursementAmount);
  const profitRate = netSales ? Math.round((estimatedProfit / netSales) * 100) : 0;
  const selectedDays = Math.max(1, Math.round((startOfDay(range.end) - startOfDay(range.start)) / 864e5) + 1);
  const drr = Number(calculated?.drr?.value??netSales/selectedDays);
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
    feeImpact:calculated?.feeImpact?.value??null,returnRate:calculated?.returnRate?.value??null,refundValueRate:calculated?.refundValueRate?.value??null,
    gstValue: calculated?.gstValue ? calculated.gstValue.value : null,
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
  // row.date is a bare calendar date (no time component) already anchored to
  // the seller's reporting day. Format it as UTC so a browser in a negative
  // UTC offset can never roll it back to the previous day.
  return (data?.trend ?? []).map(row => ({ ...row, label: new Date(row.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' }) }));
}

function readableBusinessReportRows(data) {
  const rows = amazonBusinessReportRows(data).map(row => ({
    date: row.date,
    ordered_product_sales: formatCurrency(row.ordered_product_sales),
    ordered_product_sales_b2b: formatCurrency(row.ordered_product_sales_b2b),
    units_ordered: formatNumber(row.units_ordered),
    units_ordered_b2b: formatNumber(row.units_ordered_b2b),
    total_order_items: formatNumber(row.total_order_items),
    total_order_items_b2b: formatNumber(row.total_order_items_b2b),
    average_sales_per_order_item: formatCurrency(row.average_sales_per_order_item),
    average_sales_per_order_item_b2b: formatCurrency(row.average_sales_per_order_item_b2b),
    average_units_per_order_item: Number(row.average_units_per_order_item ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
    average_units_per_order_item_b2b: Number(row.average_units_per_order_item_b2b ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
    average_selling_price: formatCurrency(row.average_selling_price)
  }));
  if (!rows.length) return [];
  const sourceRows = amazonBusinessReportRows(data);
  const totalUnits = sumRows(sourceRows, 'units_ordered');
  const totalItems = sumRows(sourceRows, 'total_order_items');
  return [...rows, {
    date: 'Total',
    ordered_product_sales: formatCurrency(sumRows(sourceRows, 'ordered_product_sales')),
    ordered_product_sales_b2b: formatCurrency(sumRows(sourceRows, 'ordered_product_sales_b2b')),
    units_ordered: formatNumber(totalUnits),
    units_ordered_b2b: formatNumber(sumRows(sourceRows, 'units_ordered_b2b')),
    total_order_items: formatNumber(totalItems),
    total_order_items_b2b: formatNumber(sumRows(sourceRows, 'total_order_items_b2b')),
    average_sales_per_order_item: formatCurrency(totalItems ? sumRows(sourceRows, 'ordered_product_sales') / totalItems : 0),
    average_sales_per_order_item_b2b: formatCurrency(sumRows(sourceRows, 'total_order_items_b2b') ? sumRows(sourceRows, 'ordered_product_sales_b2b') / sumRows(sourceRows, 'total_order_items_b2b') : 0),
    average_units_per_order_item: totalItems ? (totalUnits / totalItems).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '0',
    average_units_per_order_item_b2b: sumRows(sourceRows, 'total_order_items_b2b') ? (sumRows(sourceRows, 'units_ordered_b2b') / sumRows(sourceRows, 'total_order_items_b2b')).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '0',
    average_selling_price: formatCurrency(totalUnits ? sumRows(sourceRows, 'ordered_product_sales') / totalUnits : 0)
  }];
}
function BusinessReportDetailTable({ data }) {
  return <TableCard title="Seller Central Sales & Traffic detail" rows={readableBusinessReportRows(data)} columns={['date', 'ordered_product_sales', 'ordered_product_sales_b2b', 'units_ordered', 'units_ordered_b2b', 'total_order_items', 'total_order_items_b2b', 'average_sales_per_order_item', 'average_sales_per_order_item_b2b', 'average_units_per_order_item', 'average_units_per_order_item_b2b', 'average_selling_price']} pageSize={16} />;
}

function SalesAnalytics({ data, channelData }) {
  const { range } = useContext(DateRangeContext);
  const trend = readableTrend(data);
  return <>
    <div className="dashboard-grid">
      <Card className="panel"><PanelHeader title="Amazon Value Distribution" />{channelData.length ? <><ResponsiveContainer width="100%" height={220}><PieChart><Pie data={channelData} innerRadius={62} outerRadius={92} dataKey="value">{channelData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip formatter={value => formatCurrency(value)} /></PieChart></ResponsiveContainer><Legend items={channelData} /></> : <Empty text="No synced sales or settlement totals yet." />}</Card>
      <Card className="panel wide"><PanelHeader title={`Simple Sales Trend (${range.label})`} subtitle="date wise net sales" />{trend.length ? <ResponsiveContainer width="100%" height={280}><LineChart data={trend} margin={{ top: 12, right: 20, bottom: 8, left: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 12 }} /><YAxis tickFormatter={value => `₹${Number(value) / 1000}k`} /><Tooltip labelFormatter={label => `Date: ${label}`} formatter={value => [formatCurrency(value), 'Net sales']} /><Line type="monotone" dataKey="sales" name="Net sales" stroke="#159a82" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 7 }} /></LineChart></ResponsiveContainer> : <Empty text="No imported sales trend yet. Use the Sync above to pull SP-API reports." />}</Card>
    </div>
    <BusinessReportDetailTable data={data} />
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
function TableCard({ title, rows = [], columns, pageSize = 6 }) {
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

function SidebarLink({ to, icon, children, onClick }) {
  const location = useLocation();
  const target = new URL(to, 'http://local');
  const current = new URL(`${location.pathname}${location.search}`, 'http://local');
  const active = current.pathname === target.pathname && current.searchParams.get('view') === target.searchParams.get('view');
  return <NavLink className={active ? 'active' : ''} to={to} onClick={onClick}><span className="nav-icon" aria-hidden="true">{icon}</span><span>{children}</span></NavLink>;
}

const SEARCH_KEYWORDS = {
  dashboard: 'overview summary kpi profit',
  orderPayments: 'orders transactions money reconciliation customer payments fees',
  sales: 'revenue trend traffic',
  businessPerformance: 'quarterly report metrics',
  productPerformance: 'products asin units conversion',
  inventory: 'stock sku fba quantity',
  payouts: 'settlements bank transfers earnings',
  brand: 'asin buy box products',
  feeAudit: 'overcharge deductions leak commission',
  returns: 'refund customer disposition',
  reimbursements: 'credits lost damaged inventory',
  tax: 'gst b2b b2c invoices cgst sgst igst',
  reports: 'amazon sync source data',
  rawData: 'api json technical fields'
};

function GlobalSearch({ tenantId }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const rootRef = useRef(null);
  const normalizedQuery = query.trim().toLowerCase();
  const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);
  const results = NAV_ITEMS.filter(item => {
    const searchableText = `${item.label} ${item.view} ${SEARCH_KEYWORDS[item.view] ?? ''}`.toLowerCase();
    return queryWords.every(word => searchableText.includes(word));
  }).slice(0, 6);

  useEffect(() => {
    function closeOnOutsideClick(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  function choose(item) {
    navigate(`/seller?tenantId=${tenantId ?? ''}&view=${item.view}`);
    setQuery('');
    setOpen(false);
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && results[0]) {
      event.preventDefault();
      choose(results[0]);
    }
    if (event.key === 'Escape') setOpen(false);
  }

  return <div className="global-search" ref={rootRef}>
    <span className="global-search-icon" aria-hidden="true">⌕</span>
    <input
      type="search"
      value={query}
      placeholder="Search reports, payments, payouts…"
      aria-label="Search sections"
      aria-expanded={open}
      aria-controls="global-search-results"
      onChange={event => { setQuery(event.target.value); setOpen(true); }}
      onFocus={() => setOpen(true)}
      onKeyDown={onKeyDown}
    />
    {open && <div className="global-search-results" id="global-search-results" role="listbox">
      <span className="global-search-heading">{normalizedQuery ? 'Matching sections' : 'Quick navigation'}</span>
      {results.length ? results.map(item => <button type="button" role="option" aria-selected="false" key={item.view} onClick={() => choose(item)}>
        <span className="nav-icon" aria-hidden="true">{item.icon}</span>
        <span><b>{item.label}</b><small>Open section</small></span>
      </button>) : <p>No matching section found.</p>}
    </div>}
  </div>;
}

// Seller-facing shell: sidebar + topbar. Admins never render this component.
function SellerShell({ session, setSession }) {
  function logout() { localStorage.removeItem('token'); setSession(null); }
  const [range, setRange] = useState(defaultDateRange);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  return <div className="app-shell">
    {mobileNavOpen && <div className="sidebar-overlay" onClick={() => setMobileNavOpen(false)} />}
    <aside className={`sidebar${mobileNavOpen ? ' open' : ''}`}>
      <div className="logo"><span>W</span><div><b>WELLSURE</b><small>Seller Intelligence</small></div></div>
      <nav>
        {NAV_ITEMS.map(item => <SidebarLink key={item.view} icon={item.icon} to={`/seller?tenantId=${session?.tenantId ?? ''}&view=${item.view}`} onClick={() => setMobileNavOpen(false)}>{item.label}</SidebarLink>)}
      </nav>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <button type="button" className="hamburger-btn" aria-label="Open menu" onClick={() => setMobileNavOpen(o => !o)}>☰</button>
        <GlobalSearch tenantId={session?.tenantId} />
        <select><option>Amazon.in</option></select>
        <DateRangePicker value={range} onChange={setRange} />
        <div className="avatar">{session?.email?.[0]?.toUpperCase()}</div>
        <Button variant="dark" onClick={logout}>Logout</Button>
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
