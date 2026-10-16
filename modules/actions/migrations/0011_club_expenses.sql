-- Ausgaben "bezahlt vom Stamm": offen bis zur Ueberweisung durch die Kasse oder manuell als bezahlt markiert.
-- Empfaenger-Bankdaten fuer die Ueberweisung (IBAN nur verschluesselt, core.crypto.forModule('actions')).

ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS recipient_name text;

ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS recipient_iban_enc text;

ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS recipient_iban_last4 text;

ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS recipient_bic text;

ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS purpose text;

ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS club_paid_at timestamptz;

ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS club_paid_via text;

ALTER TABLE accounting_entries DROP CONSTRAINT IF EXISTS accounting_entries_club_paid_via_check;

ALTER TABLE accounting_entries ADD CONSTRAINT accounting_entries_club_paid_via_check
	CHECK (club_paid_via IS NULL OR club_paid_via IN ('manual', 'treasury'));

-- Bestehende Stamm-Ausgaben gelten als bezahlt (sonst entstuenden Auszahlungen fuer Altdaten)
UPDATE accounting_entries SET club_paid_at = created_at, club_paid_via = 'manual'
	WHERE type = 'expense' AND paid_by = 'club' AND club_paid_at IS NULL;
