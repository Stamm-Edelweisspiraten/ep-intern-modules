-- Modul "members" v14 (#67 01b-14, #73/#72):
-- 1. Verknuepfungs-Token (Brief-Link/QR) nicht mehr im Klartext: token_hash (HMAC mit Modulschluessel) + token_enc
--    (verschluesselt, fuer erneutes Drucken). Der Hash braucht den Schluessel der App, daher fuellt
--    `hashStoredLinkTokens` (onEnable + stuendlicher Job) den Altbestand und leert danach `token`.
-- 2. Index fuer Leitungen je Mitglied, CHECKs als Rueckhalt zur Zod-Pruefung.
-- 3. Altspalte `address` (seit 0004 nach `street` kopiert, nirgends mehr gelesen) leeren.

ALTER TABLE member_link_codes ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE member_link_codes ADD COLUMN IF NOT EXISTS token_enc text;
ALTER TABLE member_link_codes ALTER COLUMN token DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS member_link_codes_token_hash_idx ON member_link_codes (token_hash);

CREATE INDEX IF NOT EXISTS group_leaders_member_idx ON group_leaders (member_id);

-- Erst bereinigen, dann Constraints anlegen: auch NOT-VALID-CHECKs greifen bei jedem UPDATE einer Zeile,
-- eine Bereinigung einer Spalte scheiterte sonst an einem noch ungueltigen Wert einer anderen Spalte.
UPDATE groups SET meeting_time = NULL
	WHERE meeting_time IS NOT NULL AND meeting_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
UPDATE groups SET meeting_end_time = NULL
	WHERE meeting_end_time IS NOT NULL AND meeting_end_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
-- Austritt vor Eintritt: das Eintrittsdatum ist dann unplausibel (der Austritt steuert Status/Loeschfrist) -> NULL
UPDATE members SET entry_date = NULL
	WHERE exit_date IS NOT NULL AND entry_date IS NOT NULL AND exit_date < entry_date;
UPDATE members SET address = NULL WHERE address IS NOT NULL AND street IS NOT NULL;

ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_meeting_time_check;
ALTER TABLE groups ADD CONSTRAINT groups_meeting_time_check
	CHECK (meeting_time IS NULL OR meeting_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') NOT VALID;
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_meeting_end_time_check;
ALTER TABLE groups ADD CONSTRAINT groups_meeting_end_time_check
	CHECK (meeting_end_time IS NULL OR meeting_end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') NOT VALID;
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_exit_date_check;
ALTER TABLE members ADD CONSTRAINT members_exit_date_check
	CHECK (exit_date IS NULL OR entry_date IS NULL OR exit_date >= entry_date) NOT VALID;

ALTER TABLE groups VALIDATE CONSTRAINT groups_meeting_time_check;
ALTER TABLE groups VALIDATE CONSTRAINT groups_meeting_end_time_check;
ALTER TABLE members VALIDATE CONSTRAINT members_exit_date_check;
