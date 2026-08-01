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
    if (url.pathname === "/api/projects") return json(await projects(env));
    if (url.pathname === "/api/summary") return json(await summary(env, url.searchParams.get("project") || ""));
    if (url.pathname === "/api/status") return json(await status(env));
    return env.ASSETS.fetch(req);
  },
};

async function sync(env: Env) {
  const token = await accessToken(env);
  const now = new Date().toISOString();
  let processed = 0;
  let hasMore = false;
  const limit = 700;
  for (const [sheet, cfg] of Object.entries(tabs)) {
    const state = await env.DB.prepare("SELECT last_row FROM sync_state WHERE sheet_name=?").bind(sheet).first() as { last_row: number } | null;
    const start = Math.max(2, (state?.last_row ?? 1) + 1);
    const range = `'${sheet.replaceAll("'", "''")}'!${cfg.rangeCols}`;
    const rows = await sheetValues(env.SPREADSHEET_ID, range, token);
    const newRows = rows.slice(start - 1, start - 1 + limit);
    const statements = [];
    let lastRow = start - 1;
    for (let i = 0; i < newRows.length; i++) {
      const rowNo = start + i;
      const row = newRows[i];
      if (!row?.some(Boolean)) continue;
      const parsed = parseRow(sheet as keyof typeof tabs, row, rowNo);
      lastRow = rowNo;
      if (!parsed) continue;
      statements.push(env.DB.prepare(
        "INSERT OR IGNORE INTO expenses (id,source,source_row,project,month_key,month_label,expense_date,amount,merchant,category,raw_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(parsed.id, sheet, rowNo, parsed.project, parsed.monthKey, parsed.monthLabel, parsed.date, parsed.amount, parsed.merchant, parsed.category, JSON.stringify(row), now));
      processed++;
    }
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
    if (lastRow >= start) {
      await env.DB.prepare("INSERT INTO sync_state(sheet_name,last_row,updated_at) VALUES(?,?,?) ON CONFLICT(sheet_name) DO UPDATE SET last_row=excluded.last_row,updated_at=excluded.updated_at")
        .bind(sheet, lastRow, now).run();
    }
    if (rows.length > lastRow) hasMore = true;
  }
  return { processed, hasMore, syncedAt: now };
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
    project: source === "Payrolls" ? "Payroll" : clean(row[cfg.project]) || "Unassigned",
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
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

async function projects(env: Env) {
  const rows = await env.DB.prepare("SELECT project, ROUND(SUM(amount),2) total FROM expenses GROUP BY project ORDER BY project").all();
  return rows.results;
}

async function summary(env: Env, project: string) {
  const rows = await env.DB.prepare("SELECT month_key monthKey, month_label month, ROUND(SUM(amount),2) total FROM expenses WHERE project=? GROUP BY month_key, month_label ORDER BY month_key").bind(project).all();
  const total = await env.DB.prepare("SELECT ROUND(SUM(amount),2) total, COUNT(*) rows FROM expenses WHERE project=?").bind(project).first();
  return { project, total, months: rows.results };
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
