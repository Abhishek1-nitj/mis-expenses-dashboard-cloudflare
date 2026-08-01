# MIS Expenses Dashboard

Cloudflare Worker + D1 dashboard for the MIS Google Sheet.

## Features

- Syncs Claims, Expenses, Purchase Bills, and Payrolls from Google Sheets.
- Stores synced rows in Cloudflare D1.
- Sync button pulls only rows after each tab's stored cursor.
- Project dropdown with monthwise totals in `MMM-YYYY` format.
- Payroll is grouped as project `Payroll`.

## Commands

```bash
npm run typecheck
npm run build
npm run deploy
```

Cloudflare secret required:

```bash
wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```
