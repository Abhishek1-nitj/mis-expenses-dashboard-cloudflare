import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { RefreshCw, WalletCards } from "lucide-react";
import "./style.css";

type Classification = { classification: string; total: number };
type Project = { project: string; total: number };
type Month = { monthKey: string; month: string; total: number };

function App() {
  const [classes, setClasses] = useState<Classification[]>([]);
  const [classification, setClassification] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("__all");
  const [date, setDate] = useState("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState(new Date().toISOString().slice(0, 10));
  const [months, setMonths] = useState<Month[]>([]);
  const [total, setTotal] = useState<{ total: number; rows: number }>({ total: 0, rows: 0 });
  const [syncing, setSyncing] = useState(false);

  async function load() {
    const cs = await fetch("/api/classifications").then((r) => r.json()) as Classification[];
    setClasses(cs);
    const activeClass = classification || "__all";
    if (!classification) setClassification(activeClass);
    if (!activeClass) return;
    const qs = dateQs(activeClass, project, date, start, end);
    const ps = await fetch(`/api/projects?${qs}`).then((r) => r.json()) as Project[];
    setProjects(ps);
    const activeProject = project;
    const s = await fetch(`/api/summary?${dateQs(activeClass, activeProject, date, start, end)}`).then((r) => r.json());
    setMonths(s.months);
    setTotal(s.total || { total: 0, rows: 0 });
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { if (classification) load(); }, [classification, project, date, start, end]);

  const peak = useMemo(() => months.reduce<Month | null>((m, r) => !m || r.total > m.total ? r : m, null), [months]);
  const avg = useMemo(() => months.length ? months.reduce((s, r) => s + r.total, 0) / months.length : 0, [months]);
  const median = useMemo(() => {
    if (!months.length) return 0;
    const sorted = months.map((m) => m.total).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }, [months]);

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
      <label>Classification</label>
      <select value={classification} onChange={(e) => { setClassification(e.target.value); setProject("__all"); }}>
        <option value="__all">All categories</option>
        {classes.map((c) => <option key={c.classification}>{c.classification}</option>)}
      </select>
      <label>Project</label>
      <select value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="__all">All projects</option>
        {projects.map((p) => <option key={p.project}>{p.project}</option>)}
      </select>
      <label>Date</label>
      <select value={date} onChange={(e) => setDate(e.target.value)}>
        <option value="all">All dates</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="3m">Last 3 months</option>
        <option value="6m">Last 6 months</option>
        <option value="1y">Last 1 year</option>
        <option value="custom">Custom range</option>
      </select>
      {date === "custom" && <><input type="date" value={start} onChange={(e) => setStart(e.target.value)}/><input type="date" value={end} onChange={(e) => setEnd(e.target.value)}/></>}
    </section>

    <section className="stats">
      <article><WalletCards/><span>Total expense</span><strong>{money(total.total || 0)}</strong></article>
      <article><span>Avg expense per month</span><strong>{money(avg)}</strong></article>
      <article><span>Median expense per month</span><strong>{money(median)}</strong></article>
      <article><span>Peak month</span><strong>{peak ? peak.month : "-"}</strong><em>{money(peak?.total || 0)}</em></article>
    </section>

    <section className="table">
      <div className="thead"><span>Month</span><span>Total expense</span></div>
      {months.map((m) => <div className="row" key={m.monthKey}><span>{m.month}</span><strong>{money(m.total)}</strong></div>)}
    </section>
  </main>;
}

function money(n: number) {
  const v = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (v >= 1e7) return `${sign}₹${trim(v / 1e7)} cr`;
  if (v >= 1e5) return `${sign}₹${trim(v / 1e5)}L`;
  if (v >= 1e3) return `${sign}₹${trim(v / 1e3)}k`;
  return `${sign}₹${Math.round(v)}`;
}

function trim(n: number) {
  return n.toFixed(n >= 10 ? 1 : 2).replace(/\.0$|0$/g, "");
}

function dateQs(classification: string, project: string, date: string, start: string, end: string) {
  const q = new URLSearchParams({ classification, project, date, end });
  if (date === "custom" && start) q.set("start", start);
  return q.toString();
}

createRoot(document.getElementById("root")!).render(<App />);
