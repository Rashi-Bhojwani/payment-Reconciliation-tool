import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './style.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const REPORTS = ['GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', 'GET_SALES_AND_TRAFFIC_REPORT', 'GET_FBA_REIMBURSEMENTS_DATA', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'];
const COLORS = ['#f7b500', '#2f8fce', '#1f3140', '#72c6ef'];

function authHeaders() { const token = localStorage.getItem('token'); return token ? { authorization: `Bearer ${token}` } : {}; }
async function api(path, options = {}) { const res = await fetch(`${API}${path}`, { ...options, headers: { 'content-type': 'application/json', ...authHeaders(), ...(options.headers ?? {}) } }); if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Request failed'); return res.json(); }
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
function trendHint(value = '+0.0%') { return <span className={`trend ${String(value).startsWith('-') ? 'down' : ''}`}>{value}</span>; }

function Login({ setSession }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: 'admin@reconcile.local', password: 'Admin12345!', companyName: 'Demo Amazon Seller', ownerEmail: 'seller@example.com' });
  const [error, setError] = useState('');
  const navigate = useNavigate();
  async function submit(event) {
    event.preventDefault(); setError('');
    try {
      const payload = mode === 'seller' ? { companyName: form.companyName, ownerEmail: form.ownerEmail, password: form.password, marketplaceId: 'A21TJRUUN4KGV' } : { email: form.email, password: form.password };
      const data = await api(mode === 'seller' ? '/api/auth/register-seller' : '/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
      localStorage.setItem('token', data.token); setSession(data.user); navigate(data.user.role === 'admin' ? '/admin' : `/seller?tenantId=${data.user.tenantId}`);
    } catch (e) { setError(e.message); }
  }
  return <main className="login-shell">
    <section className="login-hero"><div className="brand-mark">W</div><p className="eyebrow">Wellsure × Amazon SP-API</p><h1>Beautiful reconciliation dashboards for every seller tenant.</h1><p>Connect Seller Central, pull SP-API orders and reports, and monitor payouts, sales performance, inventory and account health from one secure cockpit.</p></section>
    <Card className="login-card"><div className="segmented"><button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Login</button><button className={mode === 'seller' ? 'active' : ''} onClick={() => setMode('seller')}>Create seller</button></div><form onSubmit={submit} className="form-stack">{mode === 'seller' ? <><Input placeholder="Company name" value={form.companyName} onChange={e => setForm({ ...form, companyName: e.target.value })} /><Input placeholder="Owner email" value={form.ownerEmail} onChange={e => setForm({ ...form, ownerEmail: e.target.value })} /></> : <Input placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />}<Input type="password" placeholder="Password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /><Button>{mode === 'seller' ? 'Create seller account' : 'Login'}</Button>{error && <p className="alert error">{error}</p>}<p className="muted small">Default dev admin: admin@reconcile.local / Admin12345!</p></form></Card>
  </main>;
}

function MiniMetric({ title, value, hint }) { return <div className="mini-metric"><span>{title}</span><strong>{value}</strong>{hint && trendHint(hint)}</div>; }
function StatCard({ title, value, hint }) { return <Card className="stat-card"><p>{title}</p><strong>{value}</strong>{hint && trendHint(hint)}</Card>; }

function SellerDashboard() {
  const [params] = useSearchParams();
  const tenantId = params.get('tenantId') ?? '';
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [tokenStatus, setTokenStatus] = useState(''); const [syncing, setSyncing] = useState(false);
  async function load() { setError(''); try { setData(await api(`/api/tenants/${tenantId}/dashboard`)); } catch (e) { setError(e.message); } }
  async function syncData() { setSyncing(true); setError(''); try { const result = await api(`/api/tenants/${tenantId}/sync`, { method: 'POST', body: JSON.stringify({ reportTypes: REPORTS }) }); setTokenStatus(`Sync finished: ${result.results.map(r => `${r.reportType.replace('GET_', '')} ${r.status}`).join(', ')}`); await load(); } catch (e) { setError(e.message); } finally { setSyncing(false); } }
  useEffect(() => { if (tenantId) void load(); }, [tenantId]);
  const channelData = useMemo(() => [{ name: 'Marketplaces', value: Number(data?.orders?.order_value ?? 0) || 65 }, { name: 'D2C', value: Number(data?.kpis?.earnings ?? 0) || 25 }, { name: 'Wholesale', value: Math.abs(Number(data?.kpis?.deductions ?? 0)) || 10 }], [data]);
  return <div className="page-stack"><div className="section-title"><div><h1>Sales Performance</h1><p>Amazon SP-API powered sales, payout and product analytics.</p></div><div className="actions"><Button onClick={() => beginAmazonAuthorization(tenantId).catch(e => setError(e.message))}>Connect Amazon</Button><Button variant="secondary" onClick={load}>Refresh</Button><Button disabled={!tenantId || syncing} variant="accent" onClick={syncData}>{syncing ? 'Syncing…' : 'Sync Amazon data'}</Button></div></div>{error && <p className="alert warning">{error}</p>}{tokenStatus && <p className="alert success">{tokenStatus}</p>}
    <div className="metrics-strip"><MiniMetric title="Total Revenue" value={formatCurrency(data?.orders?.order_value)} hint="+8.2%" /><MiniMetric title="Units Sold" value={formatNumber(data?.products?.reduce((a, p) => a + Number(p.units ?? 0), 0))} hint="+11.5%" /><MiniMetric title="Avg Order Value" value={formatCurrency(Number(data?.orders?.order_value ?? 0) / Math.max(Number(data?.orders?.orders ?? 0), 1))} hint="-1.1%" /><MiniMetric title="Gross Margin" value="42.1%" hint="+0.5%" /></div>
    <div className="dashboard-grid"><Card className="panel"><PanelHeader title="Sales Channel Distribution" /><ResponsiveContainer width="100%" height={220}><PieChart><Pie data={channelData} innerRadius={62} outerRadius={92} dataKey="value">{channelData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer><Legend items={channelData} /></Card><Card className="panel wide"><PanelHeader title="Sales Trend (Last 30 Days)" />{data?.trend?.length ? <ResponsiveContainer width="100%" height={250}><AreaChart data={data.trend}><defs><linearGradient id="sales" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#2f8fce" stopOpacity={0.35}/><stop offset="95%" stopColor="#2f8fce" stopOpacity={0}/></linearGradient></defs><XAxis dataKey="date" /><YAxis /><Tooltip /><Area dataKey="sales" stroke="#2f8fce" fill="url(#sales)" strokeWidth={3} /></AreaChart></ResponsiveContainer> : <Empty text="No imported data yet. Click Sync Amazon data to request SP-API reports and populate trends." />}</Card></div>
    <div className="dashboard-grid two"><TableCard title="Category Performance Breakdown" rows={data?.products ?? []} columns={['asin', 'units', 'sales', 'buy_box']} /><TableCard title="Payment Settlements" rows={data?.payments ?? []} columns={['posted_date', 'settlement_id', 'net_amount', 'lines']} /></div><TableCard title="Recent Sync Jobs" rows={data?.jobs ?? []} columns={['report_type', 'status', 'completed_at', 'error_message']} /></div>;
}
function PanelHeader({ title }) { return <div className="panel-header"><h2>{title}</h2><span>Last 30 Days</span></div>; }
function Legend({ items }) { return <div className="legend-list">{items.map((item, i) => <div key={item.name}><span style={{ background: COLORS[i % COLORS.length] }} />{item.name}<b>{formatCurrency(item.value)}</b></div>)}</div>; }
function TableCard({ title, rows = [], columns }) { return <Card className="table-card"><PanelHeader title={title} />{rows.length ? <div className="table-wrap"><table><thead><tr>{columns.map(c => <th key={c}>{c.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{columns.map(c => <td key={c}>{row[c] ?? '—'}</td>)}</tr>)}</tbody></table></div> : <Empty text="No data imported yet." />}</Card>; }

function AdminDashboard() {
  const [tenants, setTenants] = useState([]); const [error, setError] = useState('');
  async function load() { try { setTenants((await api('/api/admin/tenants')).tenants); } catch (e) { setError(e.message); } }
  async function action(path) { await api(path, { method: 'POST' }); await load(); }
  useEffect(() => { void load(); }, []);
  const stats = useMemo(() => ({ total: tenants.length, pending: tenants.filter(t => !t.amazon_connected).length, active: tenants.filter(t => t.status === 'active').length }), [tenants]);
  return <div className="page-stack"><div className="section-title"><div><h1>Admin Portal</h1><p>Seller onboarding, Amazon authorization status, and report ingestion control.</p></div></div>{error && <p className="alert error">{error}</p>}<div className="stat-grid"><StatCard title="Sellers" value={stats.total} /><StatCard title="Pending Auth" value={stats.pending} /><StatCard title="Active Tenants" value={stats.active} /></div><Card className="table-card"><PanelHeader title="Seller Authorization Control" /><div className="table-wrap"><table><thead><tr><th>Seller</th><th>Status</th><th>Login</th><th>Amazon auth</th><th>Connected</th><th>Last sync</th><th>Actions</th></tr></thead><tbody>{tenants.map(t => <tr key={t.id}><td><b>{t.company_name}</b><small>{t.id}</small></td><td><span className={`pill ${t.status}`}>{t.status}</span></td><td>{t.login_email ?? t.owner_email ?? '—'}</td><td>{t.amazon_connected ? `${t.seller_name ?? t.company_name} · ${t.amazon_seller_id} · ${t.auth_status}` : 'Not connected'}</td><td>{t.amazon_connected_at ? new Date(t.amazon_connected_at).toLocaleString() : '—'}</td><td>{t.last_successful_sync ?? '—'}</td><td><div className="row-actions">{t.status === 'pending' && <><Button onClick={() => action(`/api/admin/tenants/${t.id}/grant-access`)}>Grant</Button><Button variant="secondary" onClick={() => action(`/api/admin/tenants/${t.id}/reject`)}>Reject</Button></>}{t.status === 'active' && <>{REPORTS.map(r => <Button variant="secondary" key={r} onClick={() => action(`/api/admin/tenants/${t.id}/sync/${r}`)}>{r.split('_')[1]}</Button>)}<Button variant="danger" onClick={() => action(`/api/admin/tenants/${t.id}/revoke-access`)}>Revoke</Button></>}</div></td></tr>)}</tbody></table></div></Card></div>;
}

function Shell({ session, setSession }) { function logout() { localStorage.removeItem('token'); setSession(null); } return <div className="app-shell"><aside className="sidebar"><div className="logo"><span>W</span><div><b>WELLSURE</b><small>Seller Intelligence</small></div></div><nav><NavLink to="/seller">Dashboard</NavLink><NavLink to="/seller">Sales Analytics</NavLink><NavLink to="/seller">Inventory</NavLink><NavLink to="/seller">Payouts</NavLink><NavLink to="/seller">Brand Analytics</NavLink>{session?.role === 'admin' && <NavLink to="/admin">Admin Portal</NavLink>}</nav></aside><main className="workspace"><header className="topbar"><div className="search">⌕ Search</div><select><option>Amazon.in</option></select><select><option>Last 30 Days</option></select><div className="avatar">{session?.email?.[0]?.toUpperCase()}</div><Button variant="dark" onClick={logout}>Logout {session?.email}</Button></header><Routes><Route path="/seller" element={<SellerDashboard />} /><Route path="/admin" element={<AdminDashboard />} /></Routes></main></div>; }
function App() { const [session, setSession] = useState(null); useEffect(() => { const token = localStorage.getItem('token'); if (token) api('/api/auth/me').then(d => setSession(d.user)).catch(() => localStorage.removeItem('token')); }, []); return <BrowserRouter>{session ? <Shell session={session} setSession={setSession} /> : <Login setSession={setSession} />}</BrowserRouter>; }

createRoot(document.getElementById('root')).render(<App />);
