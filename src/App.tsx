import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
// @ts-ignore
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
// @ts-ignore
import WalletCards from "lucide-react/dist/esm/icons/wallet-cards.mjs";
// @ts-ignore
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
// @ts-ignore
import X from "lucide-react/dist/esm/icons/x.mjs";
// @ts-ignore
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

  async function refreshVolopayTokensBeforeSync(): Promise<string> {
    // 1. Try Chrome Extension bridge if installed
    if ((window as any).__MIS_VOLOPAY_EXTENSION_INSTALLED) {
      try {
        const extPromise = new Promise<{ ok: boolean; message?: string }>((resolve) => {
          const timeout = setTimeout(() => resolve({ ok: false, message: "Extension timeout" }), 2000);
          function handler(e: MessageEvent) {
            if (e.data && e.data.type === "MIS_TOKENS_READY") {
              clearTimeout(timeout);
              window.removeEventListener("message", handler);
              resolve({ ok: e.data.ok, message: e.data.message });
            }
          }
          window.addEventListener("message", handler);
          window.postMessage({ type: "MIS_REQUEST_FRESH_TOKENS" }, "*");
        });
        const extRes = await extPromise;
        if (extRes.ok) {
          return "Session verified via Chrome Bridge";
        }
      } catch (e) {
        console.warn("Extension bridge check skipped:", e);
      }
    }

    // 2. Try Silent Local Daemon Bridge on 127.0.0.1:8765
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      const res = await fetch("http://127.0.0.1:8765/sync-tokens", {
        method: "POST",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const d = await res.json();
        return d.message || "Session verified via local bridge";
      }
    } catch {
      // Local daemon not reachable (e.g. user on mobile or other device)
    }

    return "Verifying cloud session";
  }

  async function sync() {
    if (syncing) return;
    setSyncing(true);
    setSyncStatus("Connecting to sync engine...");
    try {
      // Stage 1: Fast healthcheck to see if the local Mac daemon is available
      let localBridgeOnline = false;
      try {
        const pingCtrl = new AbortController();
        const pingTimer = setTimeout(() => pingCtrl.abort(), 1500);
        const pingRes = await fetch("http://127.0.0.1:8765/health", {
          signal: pingCtrl.signal,
        });
        clearTimeout(pingTimer);
        if (pingRes.ok) {
          localBridgeOnline = true;
        }
      } catch {
        localBridgeOnline = false;
      }

      if (localBridgeOnline) {
        setSyncStatus("Pulling fresh Volopay data into Google Sheets...");
        try {
          const syncCtrl = new AbortController();
          const syncTimer = setTimeout(() => syncCtrl.abort(), 120000); // 120s safety limit
          const bridgeRes = await fetch("http://127.0.0.1:8765/trigger-full-sync?trigger_d1=false", {
            method: "POST",
            signal: syncCtrl.signal,
          });
          clearTimeout(syncTimer);
          if (bridgeRes.ok) {
            const bridgeData = await bridgeRes.json();
            const summary = bridgeData.summary || "All sheets up to date";
            setSyncStatus(`Sheets updated (${summary}). Reconciling dashboard...`);
          } else {
            console.warn("Local bridge responded with status:", bridgeRes.status);
            setSyncStatus("Reconciling Google Sheets to dashboard...");
          }
        } catch (bridgeErr: any) {
          console.warn("Bridge sync timeout/error:", bridgeErr);
          setSyncStatus("Reconciling Google Sheets to dashboard...");
        }
      } else {
        // Fallback: If on mobile/cloud without local bridge, check Chrome extension or proceed directly
        if ((window as any).__MIS_VOLOPAY_EXTENSION_INSTALLED) {
          try {
            await new Promise((res) => {
              const t = setTimeout(res, 1000);
              window.addEventListener("message", function h(e) {
                if (e.data && e.data.type === "MIS_TOKENS_READY") {
                  clearTimeout(t);
                  window.removeEventListener("message", h);
                  res(true);
                }
              });
              window.postMessage({ type: "MIS_REQUEST_FRESH_TOKENS" }, "*");
            });
          } catch {}
        }
        setSyncStatus("Syncing Google Sheets to dashboard...");
      }

      // Stage 2: Reconcile Google Sheets into Cloudflare D1
      let currentStep = 0;
      let currentOffset = 0;
      for (;;) {
        const url = `/api/sync?step=${currentStep}&offset=${currentOffset}&mode=delta`;
        const res = await fetch(url, { method: "POST" });
        if (!res.ok) {
          const errText = await res.text();
          let cleanMsg = `Sync step failed (${res.status})`;
          if (errText.includes("Worker exceeded resource limits")) {
            cleanMsg = "Sync hit edge CPU limit. Please tap sync once more.";
          } else if (errText.includes("exceeded D1's free tier")) {
            cleanMsg = "Daily Cloudflare write quota reached. Existing records remain live.";
          } else if (!errText.startsWith("<")) {
            cleanMsg += `: ${errText.slice(0, 100)}`;
          }
          throw new Error(cleanMsg);
        }
        const data = await res.json();
        const pctStr = data.progress ? ` (${data.progress}%)` : "";
        setSyncStatus((data.message || `Syncing ${data.stepName || ""}...`) + pctStr);
        if (data.done || !data.hasMore) {
          setSyncStatus(`Sync complete! ${data.totals?.rows ? Number(data.totals.rows).toLocaleString() : ""} records active.`);
          break;
        }
        currentStep = data.nextStep;
        currentOffset = data.offset ?? 0;
      }
    } catch (err: any) {
      console.error("Sync error:", err);
      setSyncStatus(err?.message || "Sync paused");
    } finally {
      await load();
      setTimeout(() => {
        setSyncing(false);
        setSyncStatus("");
      }, 5000);
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
