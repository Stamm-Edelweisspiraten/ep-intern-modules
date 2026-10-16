-- Kasse: IBAN der Gegenpartei verschluesselt an der Buchung (Rueckzahlung auf das Herkunftskonto),
-- Zahler an der Buchung und Ablage abgeschlossener Aktions-Abrechnungen.

ALTER TABLE transactions
	ADD COLUMN IF NOT EXISTS counterparty_iban_enc text,
	ADD COLUMN IF NOT EXISTS payer_id text REFERENCES payers (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS transactions_payer_idx ON transactions (payer_id);

CREATE TABLE IF NOT EXISTS filed_accountings (
	action_id text PRIMARY KEY,
	filed_at timestamptz NOT NULL DEFAULT now(),
	filed_by text
);
