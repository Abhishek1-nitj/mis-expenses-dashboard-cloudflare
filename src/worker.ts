import type { Env } from "./env";

const tabs = {
  Claims: { rangeCols: "A:X", date: 1, project: 6, amount: 8, merchant: 7, category: 22 },
  Expenses: { rangeCols: "A:V", date: 9, project: 2, amount: 6, merchant: 4, category: 19 },
  "Purchase Bills": { rangeCols: "A:Y", date: 8, project: 2, amount: 11, merchant: 4, category: 22 },
  Payrolls: { rangeCols: "A:N", date: 4, project: -1, amount: 5, merchant: 1, category: 11 },
} as const;

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/sync" && req.method === "POST") return json(await sync(env));
    if (url.pathname === "/api/classifications") return json(await classifications(env));
    if (url.pathname === "/api/projects") return json(await projects(env, url.searchParams.get("classification") || "", dateWhere(url)));
    if (url.pathname === "/api/summary") return json(await summary(env, url.searchParams.get("classification") || "", url.searchParams.get("project") || "", dateWhere(url)));
    if (url.pathname === "/api/status") return json(await status(env));
    const res = await env.ASSETS.fetch(req);
    const headers = new Headers(res.headers);
    headers.set("cache-control", "no-store, max-age=0");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};

async function sync(env: Env) {
  const token = await accessToken(env);
  const now = new Date().toISOString();
  const classMap = await syncClassifications(env, token, now);
  let processed = 0;
  await env.DB.prepare("DELETE FROM expenses").run();
  for (const [sheet, cfg] of Object.entries(tabs)) {
    const range = `'${sheet.replaceAll("'", "''")}'!${cfg.rangeCols}`;
    const rows = await sheetValues(env.SPREADSHEET_ID, range, token);
    const newRows = rows.slice(1);
    const statements = [];
    let lastRow = 1;
    for (let i = 0; i < newRows.length; i++) {
      const rowNo = i + 2;
      const row = newRows[i];
      if (!row?.some(Boolean)) continue;
      const parsed = parseRow(sheet as keyof typeof tabs, row, rowNo);
      lastRow = rowNo;
      if (!parsed) continue;
      statements.push(env.DB.prepare(
        "INSERT OR IGNORE INTO expenses (id,source,source_row,project,classification,month_key,month_label,expense_date,amount,merchant,category,raw_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(parsed.id, sheet, rowNo, parsed.project, classMap.get(key(parsed.project)) || "Unclassified", parsed.monthKey, parsed.monthLabel, parsed.date, parsed.amount, parsed.merchant, parsed.category, JSON.stringify(row), now));
      processed++;
    }
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
    await env.DB.prepare("INSERT INTO sync_state(sheet_name,last_row,updated_at) VALUES(?,?,?) ON CONFLICT(sheet_name) DO UPDATE SET last_row=excluded.last_row,updated_at=excluded.updated_at")
      .bind(sheet, lastRow, now).run();
  }
  await backfillClassifications(env);
  return { processed, hasMore: false, classifications: classMap.size, syncedAt: now };
}

async function syncClassifications(env: Env, token: string, now: string) {
  const rows = await sheetValues(env.SPREADSHEET_ID, "Project Classification!A1:Y965", token);
  const headers = rows[0] || [];
  const statements = [];
  const map = new Map<string, string>();
  for (let c = 0; c < headers.length; c++) {
    const classification = clean(headers[c]);
    if (!classification) continue;
    for (let r = 1; r < rows.length; r++) {
      const project = clean(rows[r]?.[c]);
      if (!project) continue;
      const projectKey = key(project);
      map.set(projectKey, classification);
      statements.push(env.DB.prepare("INSERT INTO project_classifications(project_key,project,classification,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_key) DO UPDATE SET project=excluded.project,classification=excluded.classification,updated_at=excluded.updated_at").bind(projectKey, normalizeProject(project), classification, now));
      if (projectKey.includes("indiranagar")) {
        const alias = projectKey.replace("indiranagar", "indranagar");
        map.set(alias, classification);
        statements.push(env.DB.prepare("INSERT INTO project_classifications(project_key,project,classification,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_key) DO UPDATE SET project=excluded.project,classification=excluded.classification,updated_at=excluded.updated_at").bind(alias, normalizeProject(project).replace("Indiranagar", "Indranagar"), classification, now));
      }
    }
  }
  await env.DB.prepare("DELETE FROM project_classifications").run();
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
  return map;
}

async function backfillClassifications(env: Env) {
  await env.DB.prepare("UPDATE expenses SET classification=COALESCE((SELECT classification FROM project_classifications pc WHERE pc.project_key=lower(replace(replace(expenses.project,'–','-'),'—','-'))),'Unclassified')").run();
}

function parseRow(source: keyof typeof tabs, row: string[], rowNo: number) {
  const cfg = tabs[source];
  const date = normalizeDate(row[cfg.date]);
  const amount = Number(String(row[cfg.amount] || "0").replace(/,/g, ""));
  if (!date || !Number.isFinite(amount)) return null;
  const d = new Date(date + "T00:00:00Z");
  const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    id: `${source}:${rowNo}`,
    project: normalizeProject(source === "Payrolls" ? "Payroll" : clean(row[cfg.project]) || "Unassigned"),
    monthKey,
    monthLabel: d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).replace(" ", "-"),
    date,
    amount,
    merchant: clean(row[cfg.merchant]),
    category: clean(row[cfg.category]),
  };
}

function normalizeDate(v?: string) {
  if (!v) return "";
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{2,4})$/);
  if (!m) return "";
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const mm = months.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
  const yyyy = Number(m[3].length === 2 ? "20" + m[3] : m[3]);
  return mm ? `${yyyy}-${String(mm).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}` : "";
}

const clean = (v?: string) => String(v || "").trim();
const normalizeProject = (v: string) => clean(v).replace(/[–—]/g, "-").replace(/\s+/g, " ");
const key = (v: string) => normalizeProject(v).toLowerCase();
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

async function classifications(env: Env) {
  const rows = await env.DB.prepare("SELECT classification, ROUND(SUM(amount),2) total FROM expenses GROUP BY classification ORDER BY classification").all();
  return rows.results;
}

function dateWhere(url: URL) {
  const preset = url.searchParams.get("date") || "all";
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  const startParam = url.searchParams.get("start") || "";
  const d = new Date(end + "T00:00:00Z");
  const days: Record<string, number> = { "7d": 7, "30d": 30, "3m": 92, "6m": 183, "1y": 365 };
  if (preset === "custom" && startParam) return { sql: "expense_date BETWEEN ? AND ?", bind: [startParam, end] };
  if (!days[preset]) return { sql: "1=1", bind: [] as string[] };
  d.setUTCDate(d.getUTCDate() - days[preset] + 1);
  return { sql: "expense_date BETWEEN ? AND ?", bind: [d.toISOString().slice(0, 10), end] };
}

async function projects(env: Env, classification: string, date: { sql: string; bind: string[] }) {
  const all = classification === "__all";
  const rows = all
    ? await env.DB.prepare(`SELECT project, ROUND(SUM(amount),2) total FROM expenses WHERE ${date.sql} GROUP BY project ORDER BY project`).bind(...date.bind).all()
    : await env.DB.prepare(`SELECT project, ROUND(SUM(amount),2) total FROM expenses WHERE classification=? AND ${date.sql} GROUP BY project ORDER BY project`).bind(classification, ...date.bind).all();
  return rows.results;
}

async function summary(env: Env, classification: string, project: string, date: { sql: string; bind: string[] }) {
  const allClass = classification === "__all";
  const allProject = !project || project === "__all";
  const base = allClass ? (allProject ? "1=1" : "project=?") : (allProject ? "classification=?" : "classification=? AND project=?");
  const where = `${base} AND ${date.sql}`;
  const bind = [...(allClass ? (allProject ? [] : [project]) : (allProject ? [classification] : [classification, project])), ...date.bind];
  const rows = await env.DB.prepare(`SELECT month_key monthKey, month_label month, ROUND(SUM(amount),2) total FROM expenses WHERE ${where} GROUP BY month_key, month_label ORDER BY month_key DESC`).bind(...bind).all();
  const total = await env.DB.prepare(`SELECT ROUND(SUM(amount),2) total, COUNT(*) rows FROM expenses WHERE ${where}`).bind(...bind).first();
  const overall = await env.DB.prepare(`SELECT ROUND(SUM(amount),2) total FROM expenses WHERE ${date.sql}`).bind(...date.bind).first() as { total: number | null } | null;
  const classTotal = allClass ? null : await env.DB.prepare(`SELECT ROUND(SUM(amount),2) total FROM expenses WHERE classification=? AND ${date.sql}`).bind(classification, ...date.bind).first() as { total: number | null } | null;
  const projectInClass = allClass || allProject ? null : total as { total: number | null };
  const projectOverall = allProject ? null : await env.DB.prepare(`SELECT ROUND(SUM(amount),2) total FROM expenses WHERE project=? AND ${date.sql}`).bind(project, ...date.bind).first() as { total: number | null } | null;
  return {
    classification: allClass ? "All categories" : classification,
    project: allProject ? "All projects" : project,
    total,
    months: rows.results,
    percentages: {
      classificationOfAll: pct(classTotal?.total, overall?.total),
      projectOfClassification: pct(projectInClass?.total, classTotal?.total),
      projectOfAll: pct(projectOverall?.total, overall?.total),
    },
  };
}

function pct(part?: number | null, whole?: number | null) {
  return part == null || !whole ? null : (part / whole) * 100;
}

async function status(env: Env) {
  const state = await env.DB.prepare("SELECT * FROM sync_state ORDER BY sheet_name").all();
  const totals = await env.DB.prepare("SELECT COUNT(*) rows, ROUND(SUM(amount),2) total FROM expenses").first();
  return { state: state.results, totals };
}

async function sheetValues(id: string, range: string, token: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { values?: string[][] }).values || [];
}

async function accessToken(env: Env) {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now };
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claim)}`;
  const key = await crypto.subtle.importKey("pkcs8", pem(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { access_token: string }).access_token;
}

function b64(input: unknown) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new TextEncoder().encode(JSON.stringify(input));
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function pem(privateKey: string) {
  const b64key = privateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, "");
  const bin = atob(b64key);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
}
