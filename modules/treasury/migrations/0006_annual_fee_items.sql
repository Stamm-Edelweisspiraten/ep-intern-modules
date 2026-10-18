-- Jahresbeitrag: pro Rechnung nur EIN offener Posten ("Stammesbeitrag" = Gesamtsumme).
-- Die Aufschluesselung je Mitglied und Ebene steht in `annual_fee_items` (PDF-Tabelle, Idempotenz des Laufs).
-- Aeltere Rechnungen (ein Posten je Mitglied und Ebene mit `invoice_lines.fee_level`) bleiben unveraendert gueltig.

CREATE TABLE IF NOT EXISTS annual_fee_items (
	id text PRIMARY KEY,
	invoice_id text NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
	year integer NOT NULL,
	member_id text NOT NULL,
	level text NOT NULL CHECK (level IN ('stamm', 'gau', 'landesmark', 'bund')),
	amount_cents integer NOT NULL CHECK (amount_cents > 0),
	position integer NOT NULL DEFAULT 0,
	UNIQUE (invoice_id, member_id, level)
);

CREATE INDEX IF NOT EXISTS annual_fee_items_year_idx ON annual_fee_items (year, member_id);
