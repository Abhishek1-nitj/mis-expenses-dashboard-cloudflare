import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import WalletCards from "lucide-react/dist/esm/icons/wallet-cards.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import "./style.css";

type Classification = { classification: string; total: number };
type Project = { project: string; total: number };
type Month = { monthKey: string; month: string; total: number };
type Percentages = {
  classificationOfAll: number | null;
  projectOfClassification: number | null;
  projectOfAll: number | null;
};

interface ComboboxOption {
  value: string;
  label: string;
  meta?: string;
}

function SearchableSelect({
  label,
  options,
  value,
  onChange,
  placeholder = "Search...",
  allLabel = "All",
}: {
  label: string;
  options: ComboboxOption[];
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  allLabel?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Find active option label
  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption ? selectedOption.label : allLabel;

  // Filter options based on user input
  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase().trim();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (val: string) => {
    onChange(val);
    setIsOpen(false);
    setSearch("");
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setIsOpen(true);
        e.preventDefault();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1 < filtered.length ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 >= 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[activeIndex]) {
        handleSelect(filtered[activeIndex].value);
      }
    } else if (e.key === "Escape") {
      setIsOpen(false);
      setSearch("");
    }
  };

  const highlightMatch = (text: string, query: string) => {
    if (!query.trim()) return text;
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    if (index === -1) return text;
    const before = text.substring(0, index);
    const match = text.substring(index, index + query.length);
    const after = text.substring(index + query.length);
    return (
      <span>
        {before}
        <span className="highlight">{match}</span>
        {after}
      </span>
    );
  };

  return (
    <div className="field" ref={containerRef}>
      <label>{label}</label>
      <div className="combobox-wrapper">
        <div className="combobox-input-box">
          <input
            ref={inputRef}
            type="text"
            className="combobox-input"
            value={isOpen ? search : displayLabel}
            placeholder={isOpen ? placeholder : displayLabel}
            onChange={(e) => {
              setSearch(e.target.value);
              setActiveIndex(0);
              if (!isOpen) setIsOpen(true);
            }}
            onFocus={() => {
              setIsOpen(true);
              setSearch("");
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <div className="combobox-actions">
            {value !== "__all" && (
              <button
                type="button"
                className="combobox-btn"
                title="Clear selection"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSelect("__all");
                }}
              >
                <X size={15} />
              </button>
            )}
            <button
              type="button"
              className="combobox-btn"
              onClick={() => {
                setIsOpen((prev) => !prev);
                if (!isOpen) inputRef.current?.focus();
              }}
            >
              <ChevronDown size={16} />
            </button>
          </div>
        </div>

        {isOpen && (
          <div className="combobox-dropdown">
            {filtered.length === 0 ? (
              <div className="combobox-empty">No matches found</div>
            ) : (
              filtered.map((item, idx) => {
                const isSelected = item.value === value;
                const isActive = idx === activeIndex;
                return (
                  <div
                    key={item.value}
                    className={`combobox-item ${isSelected ? "selected" : ""} ${isActive ? "active" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelect(item.value);
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {isSelected ? <Check size={14} style={{ color: "#0e5f3d", flexShrink: 0 }} /> : <span style={{ width: 14 }} />}
                      <span>{highlightMatch(item.label, search)}</span>
                    </div>
                    {item.meta && <span className="combobox-item-meta">{item.meta}</span>}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [classes, setClasses] = useState<Classification[]>([]);
  const [classification, setClassification] = useState("__all");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("__all");
  const [date, setDate] = useState("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState(new Date().toISOString().slice(0, 10));
  const [months, setMonths] = useState<Month[]>([]);
  const [total, setTotal] = useState<{ total: number; rows: number }>({ total: 0, rows: 0 });
  const [percentages, setPercentages] = useState<Percentages>({ classificationOfAll: null, projectOfClassification: null, projectOfAll: null });
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>("");

  async function load() {
    try {
      const cs = (await fetch("/api/classifications").then((r) => r.json())) as Classification[];
      setClasses(cs || []);
      const activeClass = classification || "__all";
      const qs = dateQs(activeClass, project, date, start, end);
      const ps = (await fetch(`/api/projects?${qs}`).then((r) => r.json())) as Project[];
      setProjects(ps || []);
      const s = await fetch(`/api/summary?${qs}`).then((r) => r.json());
      setMonths(s?.months || []);
      setTotal(s?.total || { total: 0, rows: 0 });
      setPercentages(s?.percentages || { classificationOfAll: null, projectOfClassification: null, projectOfAll: null });
    } catch (e) {
      console.error("Failed to load dashboard data:", e);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    load();
  }, [classification, project, date, start, end]);

  const peak = useMemo(() => months.reduce<Month | null>((m, r) => (!m || r.total > m.total ? r : m), null), [months]);
  const avg = useMemo(() => (months.length ? months.reduce((s, r) => s + r.total, 0) / months.length : 0), [months]);
  const maxMonth = useMemo(() => months.reduce((m, r) => Math.max(m, r.total), 0), [months]);

  // Classification combobox options
  const classificationOptions: ComboboxOption[] = useMemo(() => {
    const allTotal = classes.reduce((sum, c) => sum + (c.total || 0), 0);
    return [
      { value: "__all", label: "All categories", meta: money(allTotal) },
      ...classes.map((c) => ({
        value: c.classification,
        label: c.classification,
        meta: money(c.total),
      })),
    ];
  }, [classes]);

  // Project combobox options
  const projectOptions: ComboboxOption[] = useMemo(() => {
    const allProjTotal = projects.reduce((sum, p) => sum + (p.total || 0), 0);
    return [
      { value: "__all", label: "All projects", meta: money(allProjTotal) },
      ...projects.map((p) => ({
        value: p.project,
        label: p.project,
        meta: money(p.total),
      })),
    ];
  }, [projects]);

  async function sync() {
    if (syncing) return;
    setSyncing(true);
    setSyncStatus("Starting sync...");
    try {
      let currentStep = 0;
      let currentOffset = 0;
      for (;;) {
        const url = `/api/sync?step=${currentStep}&offset=${currentOffset}`;
        const res = await fetch(url, { method: "POST" });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Sync step failed (${res.status}): ${errText}`);
        }
        const data = await res.json();
        setSyncStatus(data.message || `Syncing ${data.stepName || ""}...`);
        if (data.done || !data.hasMore) {
          setSyncStatus("Sync completed!");
          break;
        }
        currentStep = data.nextStep;
        currentOffset = data.offset ?? 0;
      }
      await load();
    } catch (err: any) {
      console.error("Sync error:", err);
      setSyncStatus(`Sync error: ${err?.message || "Failed"}`);
    } finally {
      setTimeout(() => {
        setSyncing(false);
        setSyncStatus("");
      }, 2000);
    }
  }

  return (
    <main>
      <section className="top">
        <div>
          <h1>ISKCON Whitefield Expenses</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {syncStatus && <span style={{ fontSize: "13px", color: "#666", fontWeight: 500 }}>{syncStatus}</span>}
          <button onClick={sync} disabled={syncing}>
            <RefreshCw size={18} className={syncing ? "spin" : ""} />
            {syncing ? "Syncing..." : "Sync data"}
          </button>
        </div>
      </section>

      <section className="controls">
        <SearchableSelect
          label="Classification"
          options={classificationOptions}
          value={classification}
          onChange={(val) => {
            setClassification(val);
            setProject("__all");
          }}
          placeholder="Type to search category..."
          allLabel="All categories"
        />

        <SearchableSelect
          label="Project"
          options={projectOptions}
          value={project}
          onChange={(val) => setProject(val)}
          placeholder="Type to search project..."
          allLabel="All projects"
        />

        <div className="field">
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
        </div>
        {date === "custom" && (
          <div className="field custom">
            <label>Range</label>
            <div>
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
        )}
      </section>

      <section className="stats">
        <article>
          <WalletCards />
          <span>Total expense</span>
          <strong>{money(total.total || 0)}</strong>
        </article>
        <article>
          <span>Avg expense per month</span>
          <strong>{money(avg)}</strong>
        </article>
        <article>
          <span>Peak month</span>
          <strong>{peak ? peak.month : "-"}</strong>
          <em>{money(peak?.total || 0)}</em>
        </article>
        {classification !== "__all" && (
          <article>
            <span>Classification share</span>
            <strong>{percent(percentages.classificationOfAll)}</strong>
          </article>
        )}
        {classification !== "__all" && project !== "__all" && (
          <>
            <article>
              <span>Project share in classification</span>
              <strong>{percent(percentages.projectOfClassification)}</strong>
            </article>
            <article>
              <span>Project share of total</span>
              <strong>{percent(percentages.projectOfAll)}</strong>
            </article>
          </>
        )}
      </section>

      <section className="table">
        <div className="thead">
          <span>Month</span>
          <span>Total expense</span>
        </div>
        {months.length === 0 ? (
          <div style={{ padding: "20px", textAlign: "center", color: "#888" }}>No expense data found for selected filters</div>
        ) : (
          months.map((m) => (
            <div className="row" key={m.monthKey}>
              <div className="bar" style={{ width: `${maxMonth ? Math.max(6, (m.total / maxMonth) * 100) : 0}%` }} />
              <span>{m.month}</span>
              <strong>{money(m.total)}</strong>
            </div>
          ))
        )}
      </section>
    </main>
  );
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

function percent(n: number | null) {
  return n == null ? "-" : `${trim(n)}%`;
}

function dateQs(classification: string, project: string, date: string, start: string, end: string) {
  const q = new URLSearchParams({ classification, project, date, end });
  if (date === "custom" && start) q.set("start", start);
  return q.toString();
}

createRoot(document.getElementById("root")!).render(<App />);
