-- Datenbank-Integrität und Indizes (#73).
-- 1) Jahresbeitrag: invoices.annual_run_id bekommt einen Fremdschlüssel auf annual_fee_runs.
--    Verwaiste Verweise (Lauf gelöscht) werden vorher auf NULL gesetzt; Löschen eines Laufs setzt NULL.
-- 2) Indizes für Fremdschlüssel, über die gefiltert bzw. bei ON DELETE SET NULL gesucht wird.
-- Hinweis: transactions.transfer_id ist bewusst KEIN Fremdschlüssel – es ist eine gemeinsame
-- Kennung beider Seiten einer Umbuchung (keine eigene Tabelle); Löschen entfernt immer beide Seiten.

UPDATE invoices SET annual_run_id = NULL
WHERE annual_run_id IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM annual_fee_runs r WHERE r.id = invoices.annual_run_id);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_annual_run_id_fkey;

ALTER TABLE invoices ADD CONSTRAINT invoices_annual_run_id_fkey
	FOREIGN KEY (annual_run_id) REFERENCES annual_fee_runs (id) ON DELETE SET NULL NOT VALID;

ALTER TABLE invoices VALIDATE CONSTRAINT invoices_annual_run_id_fkey;

CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions (category_id);

CREATE INDEX IF NOT EXISTS transactions_import_batch_idx ON transactions (import_batch_id);

CREATE INDEX IF NOT EXISTS payables_payer_idx ON payables (payer_id);
