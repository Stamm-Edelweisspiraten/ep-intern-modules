-- Bestellungen (Modul `orders`): Rechnungen und Auszahlungen mit Quelle 'order'.
-- Rechnung je Bestellung über `invoices.source_key = 'order:<bestellung>'`, Posten über
-- `invoice_lines.source_ref = 'order:<bestellung>:<posten>'`, Auszahlung über `payables.source_ref`.

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_source_check;

ALTER TABLE invoices ADD CONSTRAINT invoices_source_check
	CHECK (source IN ('manual', 'action', 'annual', 'order'));

ALTER TABLE invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_reason_check;

ALTER TABLE invoice_documents ADD CONSTRAINT invoice_documents_reason_check
	CHECK (reason IN ('registration', 'changed', 'cancelled', 'manual', 'annual', 'order'));

ALTER TABLE payables DROP CONSTRAINT IF EXISTS payables_source_check;

ALTER TABLE payables ADD CONSTRAINT payables_source_check
	CHECK (source IN ('manual', 'reimbursement', 'refund', 'credit', 'expense', 'order'));

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_key text;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_source_key_idx ON invoices (source_key)
	WHERE source_key IS NOT NULL;
