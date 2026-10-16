-- Kasse: Konten, Kategorien, Buchungen, Zahler, Rechnungen, Zuordnungen, Erinnerungen, Importe.
-- Geld als Integer-Cent (bigint), Datum als date. Keine Fremdschluessel auf Core- oder andere
-- Modul-Tabellen (member_id, action_id, participant_id, created_by sind text).

CREATE TABLE IF NOT EXISTS accounts (
	id text PRIMARY KEY,
	name text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('giro', 'cash', 'other')),
	iban text,
	opening_balance_cents bigint NOT NULL DEFAULT 0,
	opening_date date NOT NULL,
	archived_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_name_idx ON accounts (lower(name));

CREATE TABLE IF NOT EXISTS categories (
	id text PRIMARY KEY,
	name text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('income', 'expense', 'both')),
	built_in boolean NOT NULL DEFAULT false,
	archived_at timestamptz,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS categories_name_idx ON categories (lower(name));

INSERT INTO categories (id, name, kind, built_in, position) VALUES
	('cat-beitraege', 'Teilnehmerbeiträge', 'income', true, 1),
	('cat-mitgliedsbeitraege', 'Mitgliedsbeiträge', 'income', true, 2),
	('cat-zuschuesse', 'Zuschüsse', 'income', true, 3),
	('cat-spenden', 'Spenden', 'income', true, 4),
	('cat-material', 'Material', 'expense', true, 5),
	('cat-fahrt', 'Fahrtkosten', 'expense', true, 6),
	('cat-unterkunft', 'Unterkunft', 'expense', true, 7),
	('cat-verpflegung', 'Verpflegung', 'expense', true, 8),
	('cat-gebuehren', 'Bankgebühren', 'expense', true, 9),
	('cat-rueckzahlung', 'Rückzahlungen', 'expense', true, 10),
	('cat-sonstiges', 'Sonstiges', 'both', true, 11)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS import_batches (
	id text PRIMARY KEY,
	account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	file_name text NOT NULL,
	imported integer NOT NULL DEFAULT 0,
	duplicates integer NOT NULL DEFAULT 0,
	errors integer NOT NULL DEFAULT 0,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
	id text PRIMARY KEY,
	account_id text NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
	booked_on date NOT NULL,
	amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
	counterparty text,
	purpose text,
	category_id text REFERENCES categories (id) ON DELETE SET NULL,
	action_id text,
	note text,
	receipt_path text,
	receipt_name text,
	receipt_content_type text,
	transfer_id text,
	import_hash text,
	import_batch_id text REFERENCES import_batches (id) ON DELETE SET NULL,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_account_idx ON transactions (account_id, booked_on);
CREATE INDEX IF NOT EXISTS transactions_booked_idx ON transactions (booked_on);
CREATE INDEX IF NOT EXISTS transactions_action_idx ON transactions (action_id);
CREATE INDEX IF NOT EXISTS transactions_transfer_idx ON transactions (transfer_id);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_import_hash_idx
	ON transactions (account_id, import_hash) WHERE import_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS payers (
	id text PRIMARY KEY,
	name text NOT NULL,
	email text,
	note text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payer_members (
	payer_id text NOT NULL REFERENCES payers (id) ON DELETE CASCADE,
	member_id text NOT NULL,
	PRIMARY KEY (payer_id, member_id)
);

-- Ein Mitglied gehoert hoechstens zu einem Zahler (eindeutige Zuordnung von Rechnungen)
CREATE UNIQUE INDEX IF NOT EXISTS payer_members_member_idx ON payer_members (member_id);

CREATE TABLE IF NOT EXISTS invoices (
	id text PRIMARY KEY,
	number text NOT NULL UNIQUE,
	year integer NOT NULL,
	seq integer NOT NULL,
	source text NOT NULL CHECK (source IN ('manual', 'action')),
	action_id text,
	payer_id text REFERENCES payers (id) ON DELETE SET NULL,
	recipient_name text NOT NULL,
	recipient_email text,
	issued_on date NOT NULL,
	due_on date NOT NULL,
	note text,
	reminders_paused boolean NOT NULL DEFAULT false,
	cancelled_at timestamptz,
	cancel_reason text,
	-- true: vom Abgleich mit den Aktionen storniert (wird bei erneuter Teilnahme reaktiviert)
	auto_cancelled boolean NOT NULL DEFAULT false,
	paid_notified_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (year, seq)
);

CREATE INDEX IF NOT EXISTS invoices_action_idx ON invoices (action_id);
CREATE INDEX IF NOT EXISTS invoices_due_idx ON invoices (due_on);
CREATE INDEX IF NOT EXISTS invoices_payer_idx ON invoices (payer_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
	id text PRIMARY KEY,
	invoice_id text NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
	position integer NOT NULL DEFAULT 0,
	description text NOT NULL,
	amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
	waived_cents bigint NOT NULL DEFAULT 0 CHECK (waived_cents >= 0),
	waive_reason text,
	member_id text,
	participant_id text,
	action_id text,
	-- Herkunft automatischer Posten: `action:<aktion>:<teilnehmende>`
	source_ref text UNIQUE,
	CHECK (waived_cents <= amount_cents)
);

CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_lines_member_idx ON invoice_lines (member_id);
CREATE INDEX IF NOT EXISTS invoice_lines_action_idx ON invoice_lines (action_id);

CREATE TABLE IF NOT EXISTS allocations (
	id text PRIMARY KEY,
	transaction_id text NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
	line_id text NOT NULL REFERENCES invoice_lines (id) ON DELETE CASCADE,
	amount_cents bigint NOT NULL CHECK (amount_cents > 0),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (transaction_id, line_id)
);

CREATE INDEX IF NOT EXISTS allocations_line_idx ON allocations (line_id);

CREATE TABLE IF NOT EXISTS reminders (
	id text PRIMARY KEY,
	invoice_id text NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
	level integer NOT NULL CHECK (level >= 1),
	sent_at timestamptz NOT NULL DEFAULT now(),
	-- Fachliches Datum (Europe/Berlin) fuer Fristen der naechsten Stufe
	sent_on date NOT NULL,
	recipients integer NOT NULL DEFAULT 0,
	manual boolean NOT NULL DEFAULT false,
	created_by text
);

CREATE INDEX IF NOT EXISTS reminders_invoice_idx ON reminders (invoice_id);

-- Einstellungen je Aktion (ausschliessen, abweichende Faelligkeit)
CREATE TABLE IF NOT EXISTS action_settings (
	action_id text PRIMARY KEY,
	excluded boolean NOT NULL DEFAULT false,
	due_on date,
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Zustand des Abgleichs (eine Zeile)
CREATE TABLE IF NOT EXISTS sync_state (
	id integer PRIMARY KEY CHECK (id = 1),
	last_sync_at timestamptz
);

INSERT INTO sync_state (id, last_sync_at) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING;
