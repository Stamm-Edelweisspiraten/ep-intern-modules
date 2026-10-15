-- Modul "actions" Phase 4: Abrechnung (Buchungen, Belege, Auslagen-Empfaenger, Abschluss)

CREATE TABLE IF NOT EXISTS accounting_payees (
	id text PRIMARY KEY,
	action_id text NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
	name text NOT NULL,
	-- IBAN nur verschluesselt (core.crypto.forModule('actions')); iban_last4 fuer die Anzeige
	iban_enc text,
	iban_last4 text,
	bic text,
	note text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS accounting_payees_action_idx ON accounting_payees (action_id);

CREATE TABLE IF NOT EXISTS accounting_entries (
	id text PRIMARY KEY,
	action_id text NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
	type text NOT NULL CHECK (type IN ('income', 'expense')),
	category text NOT NULL CHECK (category IN (
		'food', 'lodging', 'lodging_extra', 'materials', 'other', 'travel', 'program',
		'contributions', 'subsidy', 'misc'
	)),
	description text NOT NULL,
	amount_cents integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
	entry_date date NOT NULL,
	paid_by text NOT NULL DEFAULT 'club' CHECK (paid_by IN ('club', 'person')),
	payee_id text REFERENCES accounting_payees (id) ON DELETE RESTRICT,
	receipt_path text,
	receipt_name text,
	receipt_content_type text,
	reimbursed_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CHECK ((paid_by = 'person') = (payee_id IS NOT NULL)),
	CHECK (type = 'expense' OR paid_by = 'club')
);

CREATE INDEX IF NOT EXISTS accounting_entries_action_idx ON accounting_entries (action_id, entry_date);
CREATE INDEX IF NOT EXISTS accounting_entries_payee_idx ON accounting_entries (payee_id);

CREATE TABLE IF NOT EXISTS action_accounting (
	action_id text PRIMARY KEY REFERENCES actions (id) ON DELETE CASCADE,
	closed_at timestamptz,
	closed_by text
);
