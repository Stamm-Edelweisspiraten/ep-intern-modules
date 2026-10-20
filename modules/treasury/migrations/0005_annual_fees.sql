-- Jahresbeitrag: Beitragslaeufe je Jahr, Rechnungen mit Quelle 'annual', Ebene je Rechnungsposten
-- Idempotenz der Posten ueber `invoice_lines.source_ref = 'annual:<jahr>:<mitglied>:<ebene>'`

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_source_check;

ALTER TABLE invoices ADD CONSTRAINT invoices_source_check
	CHECK (source IN ('manual', 'action', 'annual'));

ALTER TABLE invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_reason_check;

ALTER TABLE invoice_documents ADD CONSTRAINT invoice_documents_reason_check
	CHECK (reason IN ('registration', 'changed', 'cancelled', 'manual', 'annual'));

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS fee_level text;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS annual_run_id text;

CREATE TABLE IF NOT EXISTS annual_fee_runs (
	id text PRIMARY KEY,
	year integer NOT NULL UNIQUE CHECK (year BETWEEN 2000 AND 2100),
	-- Stichtag: wer an diesem Tag Mitglied ist, wird abgerechnet
	created_on date NOT NULL,
	due_on date NOT NULL,
	-- NULL = Entwurf; gesetzt = geplanter Versand (Job), solange status = 'scheduled'
	send_on date,
	status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sent')),
	sent_at timestamptz,
	-- Cent je Ebene: {"stamm":1200,"gau":800,"landesmark":200,"bund":2500}
	rates jsonb NOT NULL,
	mail_subject text NOT NULL,
	mail_body text NOT NULL,
	pdf_text text NOT NULL,
	-- Ergebnis des letzten Versands (Zaehler, keine personenbezogenen Daten)
	last_result jsonb,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoices_annual_run_idx ON invoices (annual_run_id);
