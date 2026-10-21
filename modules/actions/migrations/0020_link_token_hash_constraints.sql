-- Modul "actions" v20 (#67 01b-14, #73/#72):
-- 1. Oeffentliche Link-Tokens (Anmeldelink, Kosten-Link) nicht mehr im Klartext: token_hash (HMAC mit Modulschluessel)
--    + token_enc (verschluesselt, fuer die Anzeige der URL). Der Hash braucht den Schluessel der App, daher fuellt
--    `hashStoredLinkTokens` (onEnable + stuendlicher Job) den Altbestand und leert danach `token`.
-- 2. Fremdschluessel der Rueckzahlung und CHECKs der Aktionen als Rueckhalt zur Zod-Pruefung
--    (NOT VALID -> Altbestand bereinigen -> VALIDATE, Muster events/0003_checks.sql).

ALTER TABLE action_forms ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE action_forms ADD COLUMN IF NOT EXISTS token_enc text;
ALTER TABLE action_forms ALTER COLUMN token DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS action_forms_token_hash_idx ON action_forms (token_hash);

ALTER TABLE expense_links ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE expense_links ADD COLUMN IF NOT EXISTS token_enc text;
ALTER TABLE expense_links ALTER COLUMN token DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS expense_links_token_hash_idx ON expense_links (token_hash);

-- Rueckzahlung: Verweise auf die Buchung. Bewusst KEIN FK participant_id -> action_participants: manuelle
-- Rueckzahlungen speichern dort eine eigene UUID je eingetragenem Namen (keine Teilnehmenden).
ALTER TABLE accounting_refunds DROP CONSTRAINT IF EXISTS accounting_refunds_entry_id_fkey;
ALTER TABLE accounting_refunds ADD CONSTRAINT accounting_refunds_entry_id_fkey
	FOREIGN KEY (entry_id) REFERENCES accounting_entries (id) ON DELETE SET NULL NOT VALID;
ALTER TABLE action_refund_booking DROP CONSTRAINT IF EXISTS action_refund_booking_entry_id_fkey;
ALTER TABLE action_refund_booking ADD CONSTRAINT action_refund_booking_entry_id_fkey
	FOREIGN KEY (entry_id) REFERENCES accounting_entries (id) ON DELETE CASCADE NOT VALID;

UPDATE accounting_refunds r SET entry_id = NULL
	WHERE r.entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounting_entries e WHERE e.id = r.entry_id);
DELETE FROM action_refund_booking b
	WHERE NOT EXISTS (SELECT 1 FROM accounting_entries e WHERE e.id = b.entry_id);

ALTER TABLE accounting_refunds VALIDATE CONSTRAINT accounting_refunds_entry_id_fkey;
ALTER TABLE action_refund_booking VALIDATE CONSTRAINT action_refund_booking_entry_id_fkey;

CREATE INDEX IF NOT EXISTS accounting_refunds_entry_idx ON accounting_refunds (entry_id);
CREATE INDEX IF NOT EXISTS action_refund_booking_entry_idx ON action_refund_booking (entry_id);
CREATE INDEX IF NOT EXISTS expense_submissions_entry_idx ON expense_submissions (entry_id);

-- Aktionen: Uhrzeiten HH:MM, Ende nicht vor Start
-- Erst bereinigen, dann Constraints anlegen: auch NOT-VALID-CHECKs greifen bei jedem UPDATE einer Zeile,
-- eine Bereinigung einer Spalte scheiterte sonst an einem noch ungueltigen Wert einer anderen Spalte.
UPDATE actions SET starts_time = NULL
	WHERE starts_time IS NOT NULL AND starts_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
UPDATE actions SET ends_time = NULL
	WHERE ends_time IS NOT NULL AND ends_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
UPDATE actions SET ends_on = NULL, ends_time = NULL WHERE ends_on IS NOT NULL AND ends_on < starts_on;

ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_starts_time_check;
ALTER TABLE actions ADD CONSTRAINT actions_starts_time_check
	CHECK (starts_time IS NULL OR starts_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') NOT VALID;
ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_ends_time_check;
ALTER TABLE actions ADD CONSTRAINT actions_ends_time_check
	CHECK (ends_time IS NULL OR ends_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') NOT VALID;
ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_ends_on_check;
ALTER TABLE actions ADD CONSTRAINT actions_ends_on_check
	CHECK (ends_on IS NULL OR ends_on >= starts_on) NOT VALID;

ALTER TABLE actions VALIDATE CONSTRAINT actions_starts_time_check;
ALTER TABLE actions VALIDATE CONSTRAINT actions_ends_time_check;
ALTER TABLE actions VALIDATE CONSTRAINT actions_ends_on_check;
