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
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type",
          }
        });
      }
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

  // Step 0: Sync Master Classifications from Google Sheets into D1
  if (step === 0) {
    const count = await syncClassifications(env, token, now);
    return {
      hasMore: true,
      done: false,
      nextStep: 1,
      offset: 0,
      mode,
      voloStatus: "ok",
      stepName: "Classifications",
      message: `Master classifications synced (${count} rules). Starting Purchase Bills...`,
      progress: 10,
    };
  }

  // Final Step: Return summary totals and prune orphaned invalid records
  if (step > sheetSequence.length) {
    // Final sanity cleanup: remove any historical corrupted rows
    await env.DB.prepare("DELETE FROM expenses WHERE merchant = '[object Object]' OR merchant LIKE '%[object Object]%'").run();
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

  // Steps 1..4: Process sheets (Purchase Bills, Expenses, Claims, Payrolls)
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

  const chunkSize = 250;
  let startRow: number;
  let endRow: number;
  let isSheetDone = false;

  if (mode === "delta") {
    // Delta Mode: sync the first 500 rows (newest records) + tail 500 rows
    if (offset === 0) {
      startRow = 2;
      endRow = 501;
    } else {
      // Offset > 0: inspect tail rows
      let totalCount = 1000;
      try {
        const colA = await sheetValues(env.SPREADSHEET_ID, `'${sheetName.replaceAll("'", "''")}'!A:A`, token);
        totalCount = colA.length;
      } catch {
        totalCount = 1000;
      }
      startRow = Math.max(2, totalCount - 500);
      endRow = totalCount;
      isSheetDone = true;
    }
  } else {
    // Full Mode: paginates sequentially through all rows from row 2
    startRow = offset + 2;
    endRow = startRow + chunkSize - 1;
  }

  let rows: string[][] = [];
  try {
    const range = `'${sheetName.replaceAll("'", "''")}'!A${startRow}:Z`;
    const fetched = await sheetValues(env.SPREADSHEET_ID, range, token);
    rows = (mode === "delta" && offset > 0) ? fetched.slice(0, 500) : fetched.slice(0, chunkSize);
    if (fetched.length <= chunkSize) {
      isSheetDone = true;
    }
  } catch (err: any) {
    console.warn(`Fetch range error for ${sheetName} at row ${startRow}:`, err?.message);
    rows = [];
    isSheetDone = true;
  }

  if (rows.length === 0) {
    isSheetDone = true;
  }

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
        "INSERT OR REPLACE INTO expenses (id, source, source_row, project, classification, month_key, month_label, expense_date, amount, merchant, category, raw_json, created_at, sync_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
        now,
        `${sheetName}_${now.slice(0, 10)}`
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

  if (mode === "full") {
    isSheetDone = rows.length < chunkSize;
    // When full sync finishes for this sheet, prune any stale tail rows!
    if (isSheetDone) {
      const finalMaxRow = startRow + rows.length - 1;
      await env.DB.prepare("DELETE FROM expenses WHERE source = ? AND source_row > ?").bind(sheetName, finalMaxRow).run();
    }
  } else {
    // In delta mode: offset 0 -> next pass offset 500 -> then done
    if (offset === 0) {
      isSheetDone = false;
    }
  }

  const nextStep = isSheetDone ? step + 1 : step;
  const nextOffset = isSheetDone ? 0 : offset + chunkSize;

  const progress = Math.min(95, Math.round(15 + (step / 5) * 80));
  const msg = isSheetDone
    ? `Synced ${sheetName} (${validRowsCount} rows updated).`
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
  if (isNaN(d.getTime())) return null;
  const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const merchant = extractMerchant(row[cfg.merchant]);

  return {
    id: `${source}:${rowNo}`,
    project: normalizeProject(source === "Payrolls" ? "Payroll" : clean(row[cfg.project]) || "Unassigned"),
    monthKey,
    monthLabel: d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).replace(" ", "-"),
    date,
    amount,
    merchant,
    category: clean(row[cfg.category]),
  };
}

function extractMerchant(v: any): string {
  if (!v) return "";
  if (typeof v === "object") {
    return clean(v.name || v.displayName || v.vendorName || "");
  }
  const s = String(v).trim();
  if (s === "[object Object]" || s.toLowerCase().includes("[object object]")) {
    return "";
  }
  return clean(s);
}

function normalizeDate(v?: any): string {
  if (!v) return "";
  const s = String(v).trim();
  if (!s || s === "[object Object]" || s.toLowerCase().includes("[object object]")) return "";

  // 1. ISO format: YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const yyyy = Number(iso[1]);
    const mm = Number(iso[2]);
    const dd = Number(iso[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  // 2. Excel numeric date serial (e.g. 46290 -> 2026-09-25)
  if (/^\d{5}$/.test(s)) {
    const serial = Number(s);
    if (serial > 30000 && serial < 60000) {
      const dt = new Date(Math.round((serial - 25569) * 86400 * 1000));
      if (!isNaN(dt.getTime())) {
        return dt.toISOString().slice(0, 10);
      }
    }
  }

  // 3. Indian format DD/MM/YYYY or DD/MM/YY (or fallback MM/DD/YYYY if DD > 12)
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let p1 = Number(slash[1]);
    let p2 = Number(slash[2]);
    let yyyy = Number(slash[3].length === 2 ? "20" + slash[3] : slash[3]);
    let day = p1;
    let month = p2;
    // If month > 12 and day <= 12, it was MM/DD/YYYY
    if (month > 12 && day <= 12) {
      day = p2;
      month = p1;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${yyyy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // 4. Text month: DD-Mon-YYYY or DD Mon YYYY (e.g. 07-Sep-2026, 06 Sep 2026)
  const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{2,4})$/);
  if (m) {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const mm = months.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    const yyyy = Number(m[3].length === 2 ? "20" + m[3] : m[3]);
    const dd = Number(m[1]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  return "";
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

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*"
  }
});

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
