ALTER TABLE expenses ADD COLUMN sync_batch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_expenses_source_batch ON expenses(source, sync_batch_id);
