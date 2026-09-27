import type { Env } from "./env";

const tabs = {
  "Purchase Bills": { rangeCols: "A:Y", date: 6, project: 2, amount: 11, merchant: 4, category: 22 },
  Expenses: { rangeCols: "A:W", date: 9, project: 2, amount: 6, merchant: 4, category: 19 },
  Claims: { rangeCols: "A:X", date: 1, project: 6, amount: 8, merchant: 7, category: 22 },
  Payrolls: { rangeCols: "A:N", date: 4, project: -1, amount: 5, merchant: 1, category: 11 },
} as const;

type TabKey = keyof typeof tabs;
const sheetSequence: TabKey[] = ["Purchase Bills", "Expenses", "Claims", "Payrolls"];

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/sync" && req.method === "POST") {
      try {
        return json(await syncStep(env, url, req));
      } catch (err: any) {
        console.error("Sync step error:", err);
        return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack, step: url.searchParams.get("step"), offset: url.searchParams.get("offset") }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
    }
    if (url.pathname === "/api/volopay/auth") {
      if (req.method === "POST") {
        try {
          const body = await req.json() as any;
          if (body.access_token && body.client) {
            const now = new Date().toISOString();
            await env.DB.batch([
              env.DB.prepare("INSERT OR REPLACE INTO volopay_auth(key, value, updated_at) VALUES('access_token', ?, ?)").bind(body.access_token, now),
              env.DB.prepare("INSERT OR REPLACE INTO volopay_auth(key, value, updated_at) VALUES('client', ?, ?)").bind(body.client, now),
              ...(body.uid ? [env.DB.prepare("INSERT OR REPLACE INTO volopay_auth(key, value, updated_at) VALUES('uid', ?, ?)").bind(body.uid, now)] : []),
              ...(body.expiry ? [env.DB.prepare("INSERT OR REPLACE INTO volopay_auth(key, value, updated_at) VALUES('expiry', ?, ?)").bind(String(body.expiry), now)] : []),
            ]);
            return json({ ok: true, message: "Volopay tokens saved to D1!" });
          }
          return json({ ok: false, error: "Missing access_token or client" }, 400);
        } catch (e: any) {
          return json({ ok: false, error: e.message }, 500);
        }
      }
      const rows = await env.DB.prepare("SELECT key, updated_at FROM volopay_auth").all();
      return json({ ok: true, tokens: rows.results });
    }
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


async function syncStep(env: Env, url: URL, req?: Request) {
  let stepVal = url.searchParams.get("step");
  let offsetVal = url.searchParams.get("offset");
  let modeVal = url.searchParams.get("mode");

  if (req && req.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await req.json() as any;
      if (body && typeof body === "object") {
        if (body.step !== undefined) stepVal = String(body.step);
        if (body.offset !== undefined) offsetVal = String(body.offset);
        if (body.mode !== undefined) modeVal = String(body.mode);
      }
    } catch {}
  }

  const step = Number(stepVal ?? "0");
  const offset = Number(offsetVal ?? "0");
  const mode = modeVal ?? "delta";
  const token = await accessToken(env);
  const now = new Date().toISOString();

  // Step 0: Sync Volopay into Google Sheets + Sync Classifications into D1
  if (step === 0) {
    let voloMsg = "Volopay verified";
    try {
      const voloRes = await syncVolopayToSheets(env, token);
      voloMsg = voloRes.summary;
    } catch (vErr: any) {
      console.warn("Volopay sync warning (falling back to Google Sheets):", vErr.message);
      voloMsg = `Volopay check (${vErr.message.slice(0, 50)})`;
    }
    const count = await syncClassifications(env, token, now);
    return {
      hasMore: true,
      done: false,
      nextStep: 1,
      offset: 0,
      mode,
      stepName: "Volopay & Classifications",
      message: `${voloMsg}. Classifications synced (${count} rules). Starting Purchase Bills...`,
      progress: 10,
    };
  }

  // Final Step: Return summary totals
  if (step > sheetSequence.length) {
    const totals = await env.DB.prepare("SELECT COUNT(*) rows, ROUND(SUM(amount),2) total FROM expenses").first();
    return {
      hasMore: false,
      done: true,
      nextStep: null,
      offset: 0,
      mode,
      stepName: "Done",
      message: `Sync complete! (${totals?.rows ?? 0} total records active)`,
      progress: 100,
      totals,
      syncedAt: now,
    };
  }

  // Steps 1..4: Process sheets
  const sheetIndex = step - 1;
  const sheetName = sheetSequence[sheetIndex];
  const cfg = tabs[sheetName];
  if (!cfg) return { hasMore: false, done: true, error: "Invalid sheet index" };

  // Fetch classification lookup
  const classRows = await env.DB.prepare("SELECT project_key, classification FROM project_classifications").all();
  const classMap = new Map<string, string>();
  for (const r of classRows.results as { project_key: string; classification: string }[]) {
    classMap.set(r.project_key, r.classification);
  }

  const isDelta = mode === "delta";
  let startRow: number;
  let endRow: number;
  let isSheetDone = false;

  if (isDelta) {
    // In delta mode, find the highest valid row currently in D1 for this sheet
    const maxRes = await env.DB.prepare("SELECT COALESCE(MAX(source_row), 1) as max_row FROM expenses WHERE source = ? AND amount > 0 AND expense_date != ''").bind(sheetName).first() as { max_row: number } | null;
    const currentMax = maxRes?.max_row || 1;
    // Overlap by 50 rows to ensure recent updates or edits are refreshed
    startRow = Math.max(2, currentMax - 50);
    endRow = startRow + 500; // Fetch up to 500 latest rows
    isSheetDone = true; // Delta mode syncs the delta in 1 fast pass per sheet
  } else {
    // Full sync paginates in safe 250-row chunks
    const chunkSize = 250;
    startRow = offset + 1;
    endRow = offset + chunkSize;
  }

  const range = `'${sheetName.replaceAll("'", "''")}'!A${startRow}:Z${endRow}`;
  const rows = await sheetValues(env.SPREADSHEET_ID, range, token);

  const statements: any[] = [];
  let validRowsCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNo = startRow + i;
    if (rowNo === 1) continue; // Skip header row
    const row = rows[i];
    if (!row?.some(Boolean)) continue;
    const parsed = parseRow(sheetName, row, rowNo);
    if (!parsed) continue;
    validRowsCount++;

    const pKey = cleanKey(parsed.project);
    const classification = classMap.get(pKey) || classMap.get(parsed.project.toLowerCase()) || "Unclassified";

    statements.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO expenses (id, source, source_row, project, classification, month_key, month_label, expense_date, amount, merchant, category, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        parsed.id,
        sheetName,
        rowNo,
        parsed.project,
        classification,
        parsed.monthKey,
        parsed.monthLabel,
        parsed.date,
        parsed.amount,
        parsed.merchant,
        parsed.category,
        JSON.stringify(row),
        now
      )
    );
  }

  // Execute inserts safely in batches of 50
  if (statements.length > 0) {
    try {
      for (let i = 0; i < statements.length; i += 50) {
        await env.DB.batch(statements.slice(i, i + 50));
      }
    } catch (d1Err: any) {
      console.warn("D1 batch insert warning:", d1Err.message);
      if (d1Err.message?.includes("exceeded D1's free tier daily row write limit")) {
        return {
          hasMore: false,
          done: true,
          nextStep: null,
          offset: 0,
          mode,
          stepName: sheetName,
          message: `Daily Cloudflare write quota reached. Existing records remain active and live.`,
          progress: 100,
        };
      }
      throw d1Err;
    }
  }

  if (!isDelta) {
    isSheetDone = rows.length < 250;
  }
  const nextStep = isSheetDone ? step + 1 : step;
  const nextOffset = isSheetDone ? 0 : offset + 250;

  const progress = Math.min(95, Math.round(15 + (step / 5) * 80));
  const msg = isSheetDone
    ? `Synced ${sheetName} (${validRowsCount} recent rows updated).`
    : `Syncing ${sheetName} (rows ${startRow} - ${endRow})...`;

  return {
    hasMore: true,
    done: false,
    nextStep,
    offset: nextOffset,
    mode,
    stepName: sheetName,
    message: msg,
    progress,
    processedRows: validRowsCount,
  };
}

async function syncClassifications(env: Env, token: string, now: string) {
  const rows = await sheetValues(env.SPREADSHEET_ID, "'Project Classification'!A1:Z100", token);
  const headers = rows[0] || [];
  const statements: any[] = [];
  let count = 0;

  for (let c = 0; c < headers.length; c++) {
    const classification = clean(headers[c]);
    if (!classification) continue;

    for (let r = 1; r < rows.length; r++) {
      const project = clean(rows[r]?.[c]);
      if (!project) continue;
      count++;
      const fullKey = project.toLowerCase();
      const strippedKey = cleanKey(project);

      statements.push(
        env.DB.prepare(
          "INSERT INTO project_classifications(project_key,project,classification,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_key) DO UPDATE SET project=excluded.project,classification=excluded.classification,updated_at=excluded.updated_at"
        ).bind(strippedKey, normalizeProject(project), classification, now)
      );

      if (fullKey !== strippedKey) {
        statements.push(
          env.DB.prepare(
            "INSERT INTO project_classifications(project_key,project,classification,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_key) DO UPDATE SET project=excluded.project,classification=excluded.classification,updated_at=excluded.updated_at"
          ).bind(fullKey, normalizeProject(project), classification, now)
        );
      }
    }
  }

  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }
  return count;
}

function parseRow(source: TabKey, row: string[], rowNo: number) {
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
  const numeric = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (numeric) return `${Number(numeric[3].length === 2 ? "20" + numeric[3] : numeric[3])}-${String(Number(numeric[1])).padStart(2, "0")}-${String(Number(numeric[2])).padStart(2, "0")}`;
  const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{2,4})$/);
  if (!m) return "";
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const mm = months.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
  const yyyy = Number(m[3].length === 2 ? "20" + m[3] : m[3]);
  return mm ? `${yyyy}-${String(mm).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}` : "";
}

const clean = (v?: string) => String(v || "").trim();
const normalizeProject = (v: string) => clean(v).replace(/[–—]/g, "-").replace(/\s+/g, " ");

function cleanKey(v: string) {
  return String(v || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/^(project|department)\s*-\s*/, "")
    .replace(/indiranagar/g, "indranagar")
    .replace(/\s+/g, " ")
    .trim();
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

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
  const all = !classification || classification === "__all" || classification === "All categories";
  const rows = all
    ? await env.DB.prepare(`SELECT project, ROUND(SUM(amount),2) total FROM expenses WHERE ${date.sql} GROUP BY project ORDER BY project`).bind(...date.bind).all()
    : await env.DB.prepare(`SELECT project, ROUND(SUM(amount),2) total FROM expenses WHERE classification=? AND ${date.sql} GROUP BY project ORDER BY project`).bind(classification, ...date.bind).all();
  return rows.results;
}

async function summary(env: Env, classification: string, project: string, date: { sql: string; bind: string[] }) {
  const allClass = !classification || classification === "__all" || classification === "All categories";
  const allProject = !project || project === "__all" || project === "All projects";
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
  const classifications = await env.DB.prepare("SELECT COUNT(*) as count FROM project_classifications").first();
  const totals = await env.DB.prepare("SELECT COUNT(*) rows, ROUND(SUM(amount),2) total FROM expenses").first();
  return { classifications, totals };
}

async function sheetValues(id: string, range: string, token: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { values?: string[][] }).values || [];
}

async function sheetAppendRows(id: string, sheetTitle: string, rows: (string | number)[][], token: string): Promise<number> {
  if (!rows || rows.length === 0) return 0;
  const range = `'${sheetTitle.replaceAll("'", "''")}'!A:Z`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`Sheet append error for ${sheetTitle}:`, errText);
    return 0;
  }
  return rows.length;
}

async function accessToken(env: Env) {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now };
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

async function getVolopayAuth(env: Env) {
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM volopay_auth").all();
    const map: Record<string, string> = {};
    for (const r of (rows.results || []) as { key: string; value: string }[]) {
      map[r.key] = r.value;
    }
    return {
      accessToken: map["access_token"] || env.VOLOPAY_ACCESS_TOKEN || "mek2wR2Ze6wc-Xh6GLSSxA",
      client: map["client"] || env.VOLOPAY_CLIENT || "RXXI4JNxICLlg96mwWzP-g",
      uid: map["uid"] || env.VOLOPAY_UID || "abhishek.nitj.002@gmail.com",
      account: map["account"] || env.VOLOPAY_ACCOUNT || "iskconwhitefield",
      baseUrl: "https://api-in.volopay.co/api/v3",
    };
  } catch {
    return {
      accessToken: env.VOLOPAY_ACCESS_TOKEN || "mek2wR2Ze6wc-Xh6GLSSxA",
      client: env.VOLOPAY_CLIENT || "RXXI4JNxICLlg96mwWzP-g",
      uid: env.VOLOPAY_UID || "abhishek.nitj.002@gmail.com",
      account: env.VOLOPAY_ACCOUNT || "iskconwhitefield",
      baseUrl: "https://api-in.volopay.co/api/v3",
    };
  }
}

async function voloFetch(endpoint: string, auth: any, env: Env) {
  const url = `${auth.baseUrl}/${endpoint.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: {
      "access-token": auth.accessToken,
      client: auth.client,
      uid: auth.uid,
      "token-type": "Bearer",
      account: auth.account,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Origin: `https://${auth.account}.volopay.co.in`,
      Referer: `https://${auth.account}.volopay.co.in/`,
      Accept: "application/json, text/plain, */*",
    },
  });

  // Handle token rotation automatically
  const newAccess = res.headers.get("access-token");
  const newClient = res.headers.get("client");
  const newExpiry = res.headers.get("expiry");
  if (newAccess && (newAccess !== auth.accessToken || newClient !== auth.client)) {
    auth.accessToken = newAccess;
    if (newClient) auth.client = newClient;
    const now = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO volopay_auth(key, value, updated_at) VALUES('access_token', ?, ?)").bind(newAccess, now),
        env.DB.prepare("INSERT OR REPLACE INTO volopay_auth(key, value, updated_at) VALUES('client', ?, ?)").bind(newClient || auth.client, now),
        ...(newExpiry ? [env.DB.prepare("INSERT OR REPLACE INTO volopay_auth(key, value, updated_at) VALUES('expiry', ?, ?)").bind(newExpiry, now)] : []),
      ]);
    } catch (dbErr) {
      console.warn("Could not save rotated tokens to D1:", dbErr);
    }
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Volopay ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json() as Promise<any>;
}

async function getRecentSheetRows(id: string, sheetTitle: string, token: string, maxRows = 300): Promise<string[][]> {
  try {
    const colE = await sheetValues(id, `'${sheetTitle.replaceAll("'", "''")}'!E:E`, token);
    const total = colE.length;
    if (total <= 1) return [];
    const start = Math.max(2, total - maxRows);
    return await sheetValues(id, `'${sheetTitle.replaceAll("'", "''")}'!A${start}:Z${total + 50}`, token);
  } catch {
    return [];
  }
}

async function syncVolopayToSheets(env: Env, token: string) {
  const auth = await getVolopayAuth(env);
  let totalNew = 0;

  let authError: string | null = null;

  // 1. Claims (reimbursements)
  try {
    const claimsRes = await voloFetch("accounting/reimbursements?page=1&limit=50", auth, env);
    const claimsList = claimsRes.list || claimsRes.data || [];
    if (claimsList.length > 0) {
      const existingClaims = await getRecentSheetRows(env.SPREADSHEET_ID, "Claims", token);
      const existingKeys = new Set(existingClaims.map(r => `${clean(r[1])}_${clean(r[7])}_${clean(r[8])}`));
      const newRows: string[][] = [];
      for (const c of claimsList) {
        const txnDate = normalizeDate(c.transactionDate || c.travelDate || c.created_at);
        const merchant = clean(c.merchant);
        const amount = String(c.amountToBePaid || c.amount?.value || c.amount || "0");
        const key = `${txnDate}_${merchant}_${amount}`;
        if (!existingKeys.has(key)) {
          existingKeys.add(key);
          const ownerObj = c.createdBy || c.user || {};
          const ownerName = clean(typeof ownerObj === "object" ? ownerObj.name : c.claimOwner);
          const ownerEmail = clean(typeof ownerObj === "object" ? ownerObj.email : c.claimOwnerEmail);
          const linked = typeof c.linkedTo === "object" ? (c.linkedTo?.name || c.linkedTo?.project_name || "") : clean(c.linkedTo);
          const curr = clean(c.amount?.currency || "INR");
          const voloCat = clean(c.accountingVendorName || c.category || "Other");
          const status = clean(c.status || c.accountingStatus);
          const remarks = clean(c.memo || c.accountingMemo);
          let tallyCat = "";
          for (const tag of (c.accountingTags || [])) {
            const val = tag?.tagValue || tag?.customTextValue || "";
            if (val) { tallyCat = clean(val); break; }
          }
          newRows.push([
            clean(c.created_at || c.createdAt), txnDate, clean(c.settlementDate), clean(c.type || "out_of_pocket"),
            ownerName, ownerEmail, linked, merchant, amount, curr, voloCat, status, amount, curr,
            "", "", "", "", "", remarks, "", clean(c.approvalDate), tallyCat, ""
          ]);
        }
      }
      if (newRows.length > 0) {
        const appended = await sheetAppendRows(env.SPREADSHEET_ID, "Claims", newRows, token);
        totalNew += appended;
      }
    }
  } catch (e: any) {
    console.warn("Claims sync warning:", e.message);
    if (e.message?.includes("401") || e.message?.includes("sign in")) {
      authError = "Volopay session expired. Run 1-Click Desktop Sync to update";
    }
  }

  // 2. Expenses (card & upi)
  try {
    const expRes = await voloFetch("accounting/expenses?page=1&limit=50", auth, env);
    const expList = expRes.list || expRes.data || [];
    if (expList.length > 0) {
      const existingExp = await getRecentSheetRows(env.SPREADSHEET_ID, "Expenses", token);
      const existingTxnIds = new Set(existingExp.map(r => clean(r[11])));
      const newRows: string[][] = [];
      for (const e of expList) {
        const txnId = clean(e.accountingId || e.id);
        if (txnId && !existingTxnIds.has(txnId)) {
          existingTxnIds.add(txnId);
          const cardHolder = e.cardHolder || {};
          const ownerName = clean(typeof cardHolder === "object" ? (cardHolder.displayName || cardHolder.name) : "");
          const ownerEmail = clean(typeof cardHolder === "object" ? cardHolder.email : "");
          const projObj = e.project || {};
          const deptObj = e.department || {};
          let linked = "";
          if (typeof projObj === "object" && projObj.name) {
            linked = clean(projObj.name);
          } else if (typeof deptObj === "object" && deptObj.name) {
            linked = clean(deptObj.name);
          } else if (typeof e.linkedTo === "object") {
            linked = clean(e.linkedTo?.name || e.linkedTo?.project_name || "");
          } else {
            linked = clean(e.linkedTo);
          }
          const ptype = e.expenseViaUpi ? "UPI" : "Card Expense";
          const merchant = clean(e.merchant);
          const pMerchant = clean(e.accountingVendorName || merchant);
          const totAmt = clean(e.amount?.value || e.amount || "0");
          const curr = clean(e.amount?.currency || "INR");
          const txnDate = normalizeDate(e.transactionDate || e.accountingDate);
          const ledgerDate = clean(e.accountingDate || e.transactionDate);
          const status = clean(e.accountingStatus || e.transactionStatus);
          const gst = e.gstApplied ? "Yes" : "";
          const note = clean(e.memo);
          let tallyCat = "";
          for (const tag of (e.accountingTags || [])) {
            const val = tag?.tagValue || tag?.customTextValue || "";
            if (val) { tallyCat = clean(val); break; }
          }
          newRows.push([
            ownerName, ownerEmail, linked, ptype, merchant, pMerchant,
            totAmt, totAmt, curr, txnDate, ledgerDate, txnId, "",
            status, gst, note, curr, "1", "", tallyCat, "", "", ""
          ]);
        }
      }
      if (newRows.length > 0) {
        const appended = await sheetAppendRows(env.SPREADSHEET_ID, "Expenses", newRows, token);
        totalNew += appended;
      }
    }
  } catch (e: any) {
    console.warn("Expenses sync warning:", e.message);
    if (e.message?.includes("401") || e.message?.includes("sign in")) {
      authError = "Volopay session expired. Run 1-Click Desktop Sync to update";
    }
  }

  // 3. Purchase Bills
  try {
    const billsRes = await voloFetch("accounting/bill-pay?page=1&limit=50", auth, env);
    const billsList = billsRes.list || billsRes.data || [];
    if (billsList.length > 0) {
      const existingBills = await getRecentSheetRows(env.SPREADSHEET_ID, "Purchase Bills", token);
      const existingInvKeys = new Set(existingBills.map(r => `${clean(r[4])}_${clean(r[5])}_${clean(r[11])}`));
      const newRows: string[][] = [];
      for (const b of billsList) {
        const vendor = clean(b.vendor?.name || b.accountingVendorName || "");
        const invNo = clean(b.invoiceNumber || "");
        const totAmt = clean(b.invoicePayableAmount || b.invoiceGrossTotal || b.amountToBePaid || "0");
        const key = `${vendor}_${invNo}_${totAmt}`;
        if (!existingInvKeys.has(key)) {
          existingInvKeys.add(key);
          const userObj = b.user || b.vendorOwner || {};
          const ownerName = clean(typeof userObj === "object" ? userObj.name : "");
          const ownerEmail = clean(typeof userObj === "object" ? userObj.email : "");
          const linked = typeof b.linkedTo === "object" ? (b.linkedTo?.name || b.linkedTo?.project_name || "") : clean(b.linkedTo);
          const invDate = normalizeDate(b.invoiceDate);
          const dueDate = clean(b.dueDate);
          const txnDate = normalizeDate(b.transactionDate || b.paymentDate || b.invoiceDate);
          const subtotal = clean(b.subtotal || totAmt);
          const tax = clean(b.tax || "0");
          const tds = clean(b.tds || "0");
          const netPay = clean(b.invoicePayableAmount || totAmt);
          let tallyCat = "";
          for (const tag of (b.accountingTags || [])) {
            const val = tag?.tagValue || tag?.customTextValue || "";
            if (val) { tallyCat = clean(val); break; }
          }
          newRows.push([
            ownerName, ownerEmail, linked, "PurchaseBill", vendor, invNo,
            invDate, dueDate, txnDate, subtotal, tax, totAmt, tds, netPay,
            "1", totAmt, "INR", "", totAmt, tax, totAmt, clean(b.memo), tallyCat, "", ""
          ]);
        }
      }
      if (newRows.length > 0) {
        const appended = await sheetAppendRows(env.SPREADSHEET_ID, "Purchase Bills", newRows, token);
        totalNew += appended;
      }
    }
  } catch (e: any) {
    console.warn("Purchase Bills sync warning:", e.message);
    if (e.message?.includes("401") || e.message?.includes("sign in")) {
      authError = "Volopay session expired. Run 1-Click Desktop Sync to update";
    }
  }

  // 4. Payrolls
  try {
    const payRes = await voloFetch("accounting/payrolls?page=1&limit=50", auth, env);
    const payList = payRes.list || payRes.data || [];
    if (payList.length > 0) {
      const existingPay = await getRecentSheetRows(env.SPREADSHEET_ID, "Payrolls", token);
      const existingKeys = new Set(existingPay.map(r => `${clean(r[0])}_${clean(r[4])}_${clean(r[5])}`));
      const newRows: string[][] = [];
      for (const p of payList) {
        const empId = clean(p.accountingId || p.id);
        const txnDate = normalizeDate(p.transactionDate || p.paymentDate);
        const totAmt = clean(p.amount?.value || p.amount || "0");
        const key = `${empId}_${txnDate}_${totAmt}`;
        if (!existingKeys.has(key)) {
          existingKeys.add(key);
          const empObj = p.user || p.vendorOwner || {};
          const empName = clean(typeof empObj === "object" ? empObj.name : (p.accountingVendorName || ""));
          const empEmail = clean(typeof empObj === "object" ? empObj.email : "");
          const memo = clean(p.note);
          let tallyCat = "";
          for (const tag of (p.accountingTags || [])) {
            const val = tag?.tagValue || tag?.customTextValue || "";
            if (val) { tallyCat = clean(val); break; }
          }
          newRows.push([
            empId, empName, empEmail, "Payroll", txnDate, totAmt,
            totAmt, "INR", "1.0", memo, memo, tallyCat, "", ""
          ]);
        }
      }
      if (newRows.length > 0) {
        const appended = await sheetAppendRows(env.SPREADSHEET_ID, "Payrolls", newRows, token);
        totalNew += appended;
      }
    }
  } catch (e: any) {
    console.warn("Payrolls sync warning:", e.message);
    if (e.message?.includes("401") || e.message?.includes("sign in")) {
      authError = "Volopay session expired. Run 1-Click Desktop Sync to update";
    }
  }

  if (authError) {
    return {
      totalNew: 0,
      summary: authError
    };
  }

  return {
    totalNew,
    summary: totalNew > 0 ? `Volopay synced (${totalNew} new records appended to Sheets)` : `Volopay connected & up to date (0 new records)`
  };
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
