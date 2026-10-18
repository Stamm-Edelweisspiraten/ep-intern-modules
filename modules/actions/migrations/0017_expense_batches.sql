-- Kosten-Link: mehrere Auslagen in einem Durchgang (gemeinsame Person/Kontodaten, je Auslage ein Beleg)
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS batch_id text;

CREATE INDEX IF NOT EXISTS expense_submissions_batch_idx ON expense_submissions (batch_id);
