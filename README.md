# MIS Expenses Dashboard (Cloudflare Workers + D1 + Google Sheets Sync)

A production Cloudflare Workers + D1 + React dashboard for real-time tracking, categorization, and analysis of ISKCON Whitefield expenses across all projects, classifications, and vendors.

Live URL: [https://mis-expenses-dashboard.zoom-attendance-live.workers.dev/](https://mis-expenses-dashboard.zoom-attendance-live.workers.dev/)

---

## Key Features

1. **Searchable Autocomplete Comboboxes**:
   - Live search for **Classification** and **Project** with active count badges, rupee amount previews, and keyboard navigation.
2. **Step-by-Step Chunked Sync Engine (`/api/sync`)**:
   - Subrequest-safe chunked synchronization that bypasses Cloudflare Workers' 50-subrequest limits.
   - Synchronizes 15,450+ rows across all four core expense tabs:
     - `Claims` (accounting/reimbursements)
     - `Expenses` (accounting/expenses)
     - `Purchase Bills` (accounting/bill-pay)
     - `Payrolls` (accounting/payrolls)
   - Dynamic classification matrix mapping from `Project Classification` tab.
3. **Monthly Trend Analysis & Visual Bar Graphs**:
   - Percentage-proportional visual bars, peak month highlighting, and metric summaries (Total Expense, Monthly Average, Peak Month).
4. **Smart Incremental (Delta) Sync Engine (`sync_engine/`)**:
   - Python-based headless Volopay synchronization engine with 60-day rolling lookback for late-cleared bills and automatic token rotation.

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Vanilla CSS Design System
- **Backend / Edge**: Cloudflare Workers (TypeScript)
- **Database**: Cloudflare D1 (SQLite at the edge)
- **Data Source**: Google Sheets API + Volopay API

---

## Repository Structure

```
├── src/
│   ├── App.tsx          # React application with Searchable Comboboxes & Filters
│   ├── main.tsx         # React entrypoint
│   ├── style.css        # Modern design system, badges, and layout styling
│   ├── worker.ts        # Cloudflare Worker API & Chunked Ingestion Engine
│   └── env.d.ts         # TypeScript environment declarations
├── sync_engine/
│   ├── sync_to_mis_automatic.py  # Volopay -> Google Sheets Delta Sync Engine
│   └── volopay_client.py         # Headless Volopay API Client & Token Manager
├── wrangler.jsonc       # Cloudflare Workers & D1 configuration
├── package.json
└── README.md
```

---

## Development & Deployment

### Build and Deploy to Cloudflare
```bash
# Install dependencies
npm install

# Typecheck
npm run typecheck

# Build and deploy to Cloudflare Workers
npm run build
npx wrangler deploy
```

### Running Volopay Sync Engine
```bash
cd sync_engine

# Fast incremental delta sync
python3 sync_to_mis_automatic.py

# Full historical re-scan
python3 sync_to_mis_automatic.py --full
```
