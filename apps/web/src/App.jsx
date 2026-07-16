import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './style.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const REPORT = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';

function Button(props) {
  return <button {...props} className={`rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow ${props.className ?? ''}`} />;
}

function SellerDashboard() {
  const [tenantId, setTenantId] = useState('');
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');

  async function bootstrap() {
    setError('');
    const response = await fetch(`${API}/api/dev/bootstrap`, { method: 'POST' });
    const tenant = await response.json();
    setTenantId(tenant.id);
    setError('Tenant created in pending status. Ask an admin to grant access before loading dashboard data.');
  }

  async function loadSummary() {
    setError('');
    const response = await fetch(`${API}/api/tenants/${tenantId}/summary`);
    if (!response.ok) {
      setError(response.status === 403 ? 'Access blocked: tenant is not active yet or was suspended.' : 'Unable to load summary.');
      return;
    }
    setSummary(await response.json());
  }

  return <section className="space-y-6">
    <div className="rounded-2xl bg-white p-6 shadow">
      <h1 className="text-3xl font-bold">Seller Dashboard</h1>
      <p className="mt-2 text-slate-600">Tenant-scoped reconciliation dashboard. Pending tenants are intentionally blocked until admin approval.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button onClick={() => { location.href = `${API}/api/auth/amazon/start`; }}>Connect Amazon Account</Button>
        <Button onClick={bootstrap}>Bootstrap Test Seller</Button>
        <input className="min-w-80 rounded-lg border border-slate-300 px-3 py-2" value={tenantId} onChange={event => setTenantId(event.target.value)} placeholder="Tenant ID" />
        <Button disabled={!tenantId} onClick={loadSummary}>Refresh Seller Data</Button>
      </div>
      {error && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-amber-800">{error}</p>}
    </div>

    <div className="grid gap-4 md:grid-cols-3">
      <Metric title="Settled Net" value={`₹${summary?.settlementTotal ?? '0.00'}`} />
      <Metric title="Gross Sales" value={`₹${summary?.grossSales ?? '0.00'}`} />
      <Metric title="Fee Leak Flags" value={summary?.feeLeaks ?? 0} />
    </div>

    <div className="rounded-2xl bg-white p-6 shadow">
      <h2 className="text-xl font-semibold">Quarterly Report Data Preview</h2>
      <p className="text-sm text-slate-500">Charts/tables only. Narrative fields remain manually editable for now.</p>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={[{ month: 'M1', sales: 10 }, { month: 'M2', sales: 18 }, { month: 'M3', sales: 24 }]}><XAxis dataKey="month" /><YAxis /><Tooltip /><Line dataKey="sales" stroke="#2563eb" /></LineChart>
      </ResponsiveContainer>
    </div>

    <div className="rounded-2xl bg-white p-6 shadow">
      <h2 className="text-xl font-semibold">Recent Sync Jobs</h2>
      <table className="mt-3 w-full text-left text-sm"><tbody>{summary?.recentJobs?.map((job, index) => <tr className="border-t" key={index}><td className="py-2">{job.report_type}</td><td>{job.status}</td><td>{job.s3_key}</td><td className="text-red-700">{job.error_message}</td></tr>)}</tbody></table>
    </div>
  </section>;
}

function Metric({ title, value }) {
  return <div className="rounded-2xl bg-white p-6 shadow"><h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">{title}</h2><p className="mt-3 text-3xl font-extrabold">{value}</p></div>;
}

function AdminDashboard() {
  const [tenants, setTenants] = useState([]);
  async function load() { setTenants((await (await fetch(`${API}/api/admin/tenants`)).json()).tenants); }
  async function action(path) { await fetch(`${API}${path}`, { method: 'POST' }); await load(); }
  useEffect(() => { void load(); }, []);
  return <section className="rounded-2xl bg-white p-6 shadow">
    <h1 className="text-3xl font-bold">Admin Dashboard</h1>
    <p className="mt-2 text-slate-600">Manual access approval gates paid access until Stripe automation is added later.</p>
    <table className="mt-6 w-full text-left text-sm">
      <thead><tr className="border-b"><th className="py-2">Company</th><th>Status</th><th>Amazon</th><th>Last Sync</th><th>Actions</th></tr></thead>
      <tbody>{tenants.map(tenant => <tr className="border-b" key={tenant.id}>
        <td className="py-3"><div className="font-semibold">{tenant.company_name}</div><div className="text-xs text-slate-500">{tenant.id}</div></td>
        <td><span className="rounded-full bg-slate-100 px-3 py-1">{tenant.status}</span></td>
        <td>{tenant.amazon_connected ? 'Connected' : 'Not connected'}</td>
        <td>{tenant.last_successful_sync ?? '—'}</td>
        <td className="flex flex-wrap gap-2 py-3">
          {tenant.status === 'pending' && <><Button onClick={() => action(`/api/admin/tenants/${tenant.id}/grant-access`)}>Grant Access</Button><Button className="bg-slate-700" onClick={() => action(`/api/admin/tenants/${tenant.id}/reject`)}>Reject</Button></>}
          {tenant.status === 'active' && <><Button onClick={() => action(`/api/admin/tenants/${tenant.id}/sync/${REPORT}`)}>Trigger Sync</Button><Button className="bg-red-600" onClick={() => action(`/api/admin/tenants/${tenant.id}/revoke-access`)}>Revoke Access</Button></>}
        </td>
      </tr>)}</tbody>
    </table>
  </section>;
}

function App() {
  return <BrowserRouter><main className="mx-auto max-w-6xl space-y-6 p-8"><nav className="flex gap-3"><NavLink className="font-semibold text-blue-700" to="/">Seller</NavLink><NavLink className="font-semibold text-blue-700" to="/admin">Admin</NavLink></nav><Routes><Route path="/" element={<SellerDashboard />} /><Route path="/admin" element={<AdminDashboard />} /></Routes></main></BrowserRouter>;
}

createRoot(document.getElementById('root')).render(<App />);
