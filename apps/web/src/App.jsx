import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './style.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const REPORTS = ['GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', 'GET_SALES_AND_TRAFFIC_REPORT', 'GET_FBA_REIMBURSEMENTS_DATA', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'];

function authHeaders() { const token = localStorage.getItem('token'); return token ? { authorization: `Bearer ${token}` } : {}; }
async function api(path, options = {}) { const res = await fetch(`${API}${path}`, { ...options, headers: { 'content-type': 'application/json', ...authHeaders(), ...(options.headers ?? {}) } }); if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Request failed'); return res.json(); }
const ACCESS_TOKEN_CACHE_PREFIX = 'amazon_spapi_access_token:';
function readAmazonTokenCache(tenantId) {
  const cached = JSON.parse(localStorage.getItem(`${ACCESS_TOKEN_CACHE_PREFIX}${tenantId}`) ?? 'null');
  if (cached?.accessToken && cached?.expiresAt && Date.now() < cached.expiresAt - 60_000) return cached;
  return null;
}
async function getAmazonAccessToken(tenantId) {
  const cached = readAmazonTokenCache(tenantId);
  if (cached) return cached;
  const fresh = await api(`/api/tenants/${tenantId}/amazon/access-token`);
  localStorage.setItem(`${ACCESS_TOKEN_CACHE_PREFIX}${tenantId}`, JSON.stringify(fresh));
  return fresh;
}
async function beginAmazonAuthorization(tenantId) {
  const { url } = await api(`/api/auth/amazon/start?tenantId=${tenantId}&json=1`);
  window.location.assign(url);
}

function Button(props) { return <button {...props} className={`rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50 ${props.className ?? ''}`} />; }
function Input(props) { return <input {...props} className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-blue-500" />; }
function Card({ children, className = '' }) { return <section className={`rounded-3xl border border-slate-200 bg-white p-6 shadow-sm ${className}`}>{children}</section>; }
function Metric({ title, value, hint }) { return <Card><p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{title}</p><p className="mt-3 text-3xl font-black text-slate-950">{value}</p>{hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}</Card>; }

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
  return <main className="mx-auto grid min-h-[80vh] max-w-6xl items-center gap-8 p-8 lg:grid-cols-[1.1fr_.9fr]">
    <div><p className="text-sm font-bold uppercase tracking-[0.3em] text-blue-600">Enterprise Amazon SP-API reconciliation</p><h1 className="mt-4 text-5xl font-black leading-tight">Sales, settlements, orders and product performance in one tenant-safe cockpit.</h1><p className="mt-5 text-lg text-slate-600">Admins approve seller authorizations and control access. Sellers get an easy GUI that turns SP-API reports, Orders, Finances and product signals into operational dashboards.</p></div>
    <Card><div className="mb-4 flex gap-2"><Button className={mode === 'login' ? '' : 'bg-slate-700'} onClick={() => setMode('login')}>Login</Button><Button className={mode === 'seller' ? '' : 'bg-slate-700'} onClick={() => setMode('seller')}>Create seller</Button></div><form onSubmit={submit} className="space-y-3">{mode === 'seller' ? <><Input placeholder="Company name" value={form.companyName} onChange={e => setForm({ ...form, companyName: e.target.value })} /><Input placeholder="Owner email" value={form.ownerEmail} onChange={e => setForm({ ...form, ownerEmail: e.target.value })} /></> : <Input placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />}<Input type="password" placeholder="Password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /><Button>{mode === 'seller' ? 'Create pending seller' : 'Login'}</Button>{error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}<p className="text-xs text-slate-500">Default dev admin: admin@reconcile.local / Admin12345! Change ADMIN_EMAIL and ADMIN_PASSWORD in production.</p></form></Card>
  </main>;
}

function SellerDashboard() {
  const [params] = useSearchParams();
  const tenantId = params.get('tenantId') ?? '';
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [tokenStatus, setTokenStatus] = useState('');
  async function load() { setError(''); try { setData(await api(`/api/tenants/${tenantId}/dashboard`)); } catch (e) { setError(e.message); } }
  useEffect(() => { if (tenantId) void load(); }, [tenantId]);
  return <div className="space-y-6"><Card><h1 className="text-3xl font-black">Seller command center</h1><p className="mt-2 text-slate-600">End-to-end performance once an admin activates this tenant. Amazon authorization connects SP-API data ingestion.</p><div className="mt-4 flex flex-wrap gap-3"><Button disabled={!tenantId} onClick={() => beginAmazonAuthorization(tenantId).catch(e => setError(e.message))}>Connect Amazon SP-API</Button><Button disabled={!tenantId} onClick={load}>Refresh dashboard</Button><Button disabled={!tenantId} className="bg-emerald-600" onClick={() => getAmazonAccessToken(tenantId).then(t => setTokenStatus(`Access token cached locally until ${new Date(t.expiresAt).toLocaleTimeString()}`)).catch(e => setError(e.message))}>Warm token cache</Button></div>{error && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-amber-800">{error}</p>}{tokenStatus && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-emerald-800">{tokenStatus}</p>}</Card><div className="grid gap-4 md:grid-cols-4"><Metric title="Net settled" value={`₹${data?.kpis?.net_settled ?? '0.00'}`} /><Metric title="Earnings" value={`₹${data?.kpis?.earnings ?? '0.00'}`} /><Metric title="Deductions" value={`₹${data?.kpis?.deductions ?? '0.00'}`} /><Metric title="Orders" value={data?.orders?.orders ?? 0} hint={`₹${data?.orders?.order_value ?? '0.00'} booked`} /></div><Card><h2 className="text-xl font-bold">Sales and unit trend</h2>{data?.trend?.length ? <ResponsiveContainer width="100%" height={280}><LineChart data={data.trend}><XAxis dataKey="date" /><YAxis /><Tooltip /><Line dataKey="sales" stroke="#2563eb" strokeWidth={2} /><Line dataKey="units" stroke="#16a34a" strokeWidth={2} /></LineChart></ResponsiveContainer> : <Empty text="Sync Sales & Traffic to populate trends." />}</Card><div className="grid gap-6 lg:grid-cols-2"><TableCard title="Product performance" rows={data?.products ?? []} columns={['asin', 'units', 'sales', 'buy_box']} /><TableCard title="Payment settlements" rows={data?.payments ?? []} columns={['posted_date', 'settlement_id', 'net_amount', 'lines']} /></div><TableCard title="Recent sync jobs" rows={data?.jobs ?? []} columns={['report_type', 'status', 'completed_at', 'error_message']} /></div>;
}

function TableCard({ title, rows, columns }) { return <Card><h2 className="text-xl font-bold">{title}</h2>{rows.length ? <div className="mt-4 overflow-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b">{columns.map(c => <th className="py-2 pr-4" key={c}>{c.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr className="border-b" key={i}>{columns.map(c => <td className="py-2 pr-4" key={c}>{row[c] ?? '—'}</td>)}</tr>)}</tbody></table></div> : <Empty text="No data imported yet." />}</Card>; }
function Empty({ text }) { return <p className="mt-4 rounded-2xl bg-slate-50 p-5 text-sm text-slate-600">{text}</p>; }

function AdminDashboard() {
  const [tenants, setTenants] = useState([]); const [error, setError] = useState('');
  async function load() { try { setTenants((await api('/api/admin/tenants')).tenants); } catch (e) { setError(e.message); } }
  async function action(path) { await api(path, { method: 'POST' }); await load(); }
  useEffect(() => { void load(); }, []);
  const stats = useMemo(() => ({ total: tenants.length, pending: tenants.filter(t => t.status === 'pending').length, active: tenants.filter(t => t.status === 'active').length }), [tenants]);
  return <div className="space-y-6"><Card><h1 className="text-3xl font-black">Admin portal</h1><p className="mt-2 text-slate-600">Authorize sellers, view their SP-API auth state, and trigger ingestion jobs before users can log into active dashboards.</p>{error && <p className="mt-3 text-red-700">{error}</p>}</Card><div className="grid gap-4 md:grid-cols-3"><Metric title="Sellers" value={stats.total} /><Metric title="Pending auth" value={stats.pending} /><Metric title="Active tenants" value={stats.active} /></div><Card><div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="py-2">Seller</th><th>Status</th><th>Login</th><th>Amazon auth</th><th>Connected</th><th>Last sync</th><th>Actions</th></tr></thead><tbody>{tenants.map(t => <tr className="border-b" key={t.id}><td className="py-3"><b>{t.company_name}</b><div className="text-xs text-slate-500">{t.id}</div></td><td>{t.status}</td><td>{t.login_email ?? t.owner_email ?? '—'}</td><td>{t.amazon_connected ? `${t.seller_name ?? t.company_name} · ${t.amazon_seller_id} · ${t.auth_status}` : 'Not connected'}</td><td>{t.amazon_connected_at ? new Date(t.amazon_connected_at).toLocaleString() : '—'}</td><td>{t.last_successful_sync ?? '—'}</td><td className="flex flex-wrap gap-2 py-3">{t.status === 'pending' && <><Button onClick={() => action(`/api/admin/tenants/${t.id}/grant-access`)}>Grant</Button><Button className="bg-slate-700" onClick={() => action(`/api/admin/tenants/${t.id}/reject`)}>Reject</Button></>}{t.status === 'active' && <>{REPORTS.map(r => <Button className="bg-indigo-600" key={r} onClick={() => action(`/api/admin/tenants/${t.id}/sync/${r}`)}>{r.split('_')[1]}</Button>)}<Button className="bg-red-600" onClick={() => action(`/api/admin/tenants/${t.id}/revoke-access`)}>Revoke</Button></>}</td></tr>)}</tbody></table></div></Card></div>;
}

function Shell({ session, setSession }) { function logout() { localStorage.removeItem('token'); setSession(null); } return <main className="mx-auto max-w-7xl space-y-6 p-6"><nav className="flex items-center justify-between"><div className="flex gap-3"><NavLink className="font-bold text-blue-700" to="/seller">Seller</NavLink>{session?.role === 'admin' && <NavLink className="font-bold text-blue-700" to="/admin">Admin</NavLink>}</div><Button className="bg-slate-800" onClick={logout}>Logout {session?.email}</Button></nav><Routes><Route path="/seller" element={<SellerDashboard />} /><Route path="/admin" element={<AdminDashboard />} /></Routes></main>; }
function App() { const [session, setSession] = useState(null); useEffect(() => { const token = localStorage.getItem('token'); if (token) api('/api/auth/me').then(d => setSession(d.user)).catch(() => localStorage.removeItem('token')); }, []); return <BrowserRouter>{session ? <Shell session={session} setSession={setSession} /> : <Login setSession={setSession} />}</BrowserRouter>; }

createRoot(document.getElementById('root')).render(<App />);
