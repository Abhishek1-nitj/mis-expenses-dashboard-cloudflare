ALTER TABLE expenses ADD COLUMN classification TEXT NOT NULL DEFAULT 'Unclassified';

CREATE TABLE IF NOT EXISTS project_classifications (
  project_key TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  classification TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_classification_month ON expenses(classification, month_key);
