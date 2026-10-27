-- Modul "actions": Rueckzahlung ganz oder teilweise an den Stamm spenden (je Person)
-- Auszahlung = amount_cents - donated_cents; Teilspenden nur in ganzen Euro (ausser "alles spenden").

ALTER TABLE accounting_refunds ADD COLUMN IF NOT EXISTS donated_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE accounting_refunds ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE accounting_refunds ADD COLUMN IF NOT EXISTS decided_via text;
ALTER TABLE accounting_refunds ADD COLUMN IF NOT EXISTS decided_by text;
ALTER TABLE accounting_refunds ADD COLUMN IF NOT EXISTS donor_note text;
ALTER TABLE accounting_refunds ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE accounting_refunds ADD COLUMN IF NOT EXISTS token_enc text;

ALTER TABLE accounting_refunds DROP CONSTRAINT IF EXISTS accounting_refunds_donated_cents_check;
ALTER TABLE accounting_refunds ADD CONSTRAINT accounting_refunds_donated_cents_check CHECK (
	donated_cents >= 0 AND donated_cents <= amount_cents
	AND (donated_cents % 100 = 0 OR donated_cents = amount_cents)
);
ALTER TABLE accounting_refunds DROP CONSTRAINT IF EXISTS accounting_refunds_decided_via_check;
ALTER TABLE accounting_refunds ADD CONSTRAINT accounting_refunds_decided_via_check
	CHECK (decided_via IS NULL OR decided_via IN ('internal', 'link'));
ALTER TABLE accounting_refunds DROP CONSTRAINT IF EXISTS accounting_refunds_donor_note_check;
ALTER TABLE accounting_refunds ADD CONSTRAINT accounting_refunds_donor_note_check
	CHECK (donor_note IS NULL OR char_length(donor_note) <= 300);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_refunds_token_hash_idx ON accounting_refunds (token_hash);

-- Spendet jede Person alles, gibt es keine Rueckzahlungs-Buchung mehr (Betrag muss > 0 sein):
-- der Snapshot bleibt, die Buchung entfaellt.
ALTER TABLE action_refund_booking ALTER COLUMN entry_id DROP NOT NULL;
ALTER TABLE action_refund_booking DROP CONSTRAINT IF EXISTS action_refund_booking_entry_id_fkey;
ALTER TABLE action_refund_booking ADD CONSTRAINT action_refund_booking_entry_id_fkey
	FOREIGN KEY (entry_id) REFERENCES accounting_entries (id) ON DELETE SET NULL;
