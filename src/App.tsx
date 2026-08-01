import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { RefreshCw, WalletCards } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import "./style.css";

type Project = { project: string; total: number };
type Month = { monthKey: string; month: string; total: number };

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [months, setMonths] = useState<Month[]>([]);
  const [total, setTotal] = useState<{ total: number; rows: number }>({ total: 0, rows: 0 });
  const [syncing, setSyncing] = useState(false);

  async function load() {
    const ps = await fetch("/api/projects").then((r) => r.json()) as Project[];
    setProjects(ps);
    const active = project || ps[0]?.project || "";
    if (!project) setProject(active);
    if (active) {
      const s = await fetch(`/api/summary?project=${encodeURIComponent(active)}`).then((r) => r.json());
      setMonths(s.months);
      setTotal(s.total || { total: 0, rows: 0 });
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { if (project) load(); }, [project]);

  const peak = useMemo(() => months.reduce((m, r) => Math.max(m, r.total), 0), [months]);

  async function sync() {
    setSyncing(true);
    try {
      for (;;) {
        const r = await fetch("/api/sync", { method: "POST" }).then((x) => x.json());
        if (!r.hasMore) break;
      }
      await load();
    } finally { setSyncing(false); }
  }

  return <main>
    <section className="top">
      <div>
        <p className="eyebrow">MIS expense intelligence</p>
        <h1>Project and monthwise dashboard</h1>
      </div>
      <button onClick={sync} disabled={syncing}><RefreshCw size={18} className={syncing ? "spin" : ""}/> Sync data</button>
    </section>

    <section className="controls">
      <label>Project</label>
      <select value={project} onChange={(e) => setProject(e.target.value)}>
        {projects.map((p) => <option key={p.project}>{p.project}</option>)}
      </select>
    </section>

    <section className="stats">
      <article><WalletCards/><span>Total expense</span><strong>{money(total.total || 0)}</strong></article>
      <article><span>Rows synced</span><strong>{total.rows || 0}</strong></article>
      <article><span>Months</span><strong>{months.length}</strong></article>
      <article><span>Peak month</span><strong>{money(peak)}</strong></article>
    </section>

    <section className="chart">
      <ResponsiveContainer width="100%" height={360}>
        <AreaChart data={months}>
          <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="#0e9f6e" stopOpacity=".55"/><stop offset="95%" stopColor="#0e9f6e" stopOpacity=".04"/></linearGradient></defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#d9e2df"/>
          <XAxis dataKey="month" tickLine={false}/>
          <YAxis tickFormatter={(v) => `₹${Math.round(Number(v)/1000)}k`} tickLine={false}/>
          <Tooltip formatter={(v) => money(Number(v))}/>
          <Area type="monotone" dataKey="total" stroke="#0e9f6e" strokeWidth={3} fill="url(#g)"/>
        </AreaChart>
      </ResponsiveContainer>
    </section>

    <section className="table">
      <div className="thead"><span>Month</span><span>Total expense</span></div>
      {months.map((m) => <div className="row" key={m.monthKey}><span>{m.month}</span><strong>{money(m.total)}</strong></div>)}
    </section>
  </main>;
}

const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

createRoot(document.getElementById("root")!).render(<App />);
