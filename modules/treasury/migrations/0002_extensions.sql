-- Kasse, Ausbaustufe 2: Standardkonto, Bankverbindung der Zahler, IBAN-Abgleich beim Import,
-- ausstehende Ueberweisungen (Verbindlichkeiten) und versionierte Rechnungsdokumente.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_default_idx ON accounts (is_default) WHERE is_default;

UPDATE accounts SET is_default = true
WHERE id = (SELECT id FROM accounts WHERE archived_at IS NULL ORDER BY created_at, id LIMIT 1)
	AND NOT EXISTS (SELECT 1 FROM accounts WHERE is_default);

ALTER TABLE payers
	ADD COLUMN IF NOT EXISTS account_holder text,
	ADD COLUMN IF NOT EXISTS iban_enc text,
	ADD COLUMN IF NOT EXISTS iban_last4 text,
	ADD COLUMN IF NOT EXISTS iban_hash text,
	ADD COLUMN IF NOT EXISTS bic text;

CREATE INDEX IF NOT EXISTS payers_iban_hash_idx ON payers (iban_hash);

-- IBAN der Gegenpartei nur als HMAC (Abgleich mit Zahlern) und letzte vier Stellen (Anzeige)
ALTER TABLE transactions
	ADD COLUMN IF NOT EXISTS counterparty_iban_hash text,
	ADD COLUMN IF NOT EXISTS counterparty_iban_last4 text;

-- Ausstehende Ueberweisungen: was der Stamm (noch) zahlen muss
CREATE TABLE IF NOT EXISTS payables (
	id text PRIMARY KEY,
	source text NOT NULL CHECK (source IN ('manual', 'reimbursement', 'refund', 'credit')),
	-- Herkunft automatischer Posten: `reimb:<aktion>:<empfaenger>`, `refund:<aktion>:<eintrag>`, `credit:<rechnung>`
	source_ref text UNIQUE,
	action_id text,
	payer_id text REFERENCES payers (id) ON DELETE SET NULL,
	member_id text,
	recipient_name text NOT NULL,
	iban_enc text,
	iban_last4 text,
	bic text,
	description text NOT NULL,
	amount_cents bigint NOT NULL CHECK (amount_cents > 0),
	due_on date,
	note text,
	receipt_path text,
	receipt_name text,
	receipt_content_type text,
	cancelled_at timestamptz,
	auto_cancelled boolean NOT NULL DEFAULT false,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payables_action_idx ON payables (action_id);

CREATE TABLE IF NOT EXISTS payable_payments (
	id text PRIMARY KEY,
	payable_id text NOT NULL REFERENCES payables (id) ON DELETE CASCADE,
	transaction_id text NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
	amount_cents bigint NOT NULL CHECK (amount_cents > 0),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (payable_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS payable_payments_tx_idx ON payable_payments (transaction_id);

-- Versionen einer Rechnung (PDF wird aus dem Snapshot neu erzeugt)
CREATE TABLE IF NOT EXISTS invoice_documents (
	id text PRIMARY KEY,
	invoice_id text NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
	version integer NOT NULL,
	reason text NOT NULL CHECK (reason IN ('registration', 'changed', 'cancelled', 'manual')),
	snapshot jsonb NOT NULL,
	sent_at timestamptz,
	recipients integer NOT NULL DEFAULT 0,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (invoice_id, version)
);
