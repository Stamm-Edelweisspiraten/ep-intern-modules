-- Kosten-Link: Personen reichen ohne Login Auslagen (Beleg + Kontodaten) ein; Uebernahme erst nach Pruefung.

CREATE TABLE IF NOT EXISTS expense_links (
	action_id text PRIMARY KEY REFERENCES actions (id) ON DELETE CASCADE,
	token text NOT NULL UNIQUE,
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expense_submissions (
	id text PRIMARY KEY,
	action_id text NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
	submitter_name text NOT NULL,
	submitter_email text,
	category text NOT NULL,
	description text NOT NULL,
	amount_cents integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
	expense_date date NOT NULL,
	account_holder text,
	-- IBAN nur verschluesselt (core.crypto.forModule('actions')); wird beim Ablehnen geloescht
	iban_enc text,
	iban_last4 text,
	bic text,
	receipt_path text,
	receipt_name text,
	receipt_content_type text,
	note text,
	created_at timestamptz NOT NULL DEFAULT now(),
	decided_at timestamptz,
	decided_by text,
	entry_id text REFERENCES accounting_entries (id) ON DELETE SET NULL,
	reject_reason text
);

CREATE INDEX IF NOT EXISTS expense_submissions_action_idx ON expense_submissions (action_id, status, created_at);
