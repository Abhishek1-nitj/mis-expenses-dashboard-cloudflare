CREATE TABLE IF NOT EXISTS sync_state (
  sheet_name TEXT PRIMARY KEY,
  last_row INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  project TEXT NOT NULL,
  month_key TEXT NOT NULL,
  month_label TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  amount REAL NOT NULL,
  merchant TEXT,
  category TEXT,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_project_month ON expenses(project, month_key);
CREATE INDEX IF NOT EXISTS idx_expenses_month ON expenses(month_key);
