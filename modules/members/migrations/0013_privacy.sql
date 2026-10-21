-- Issue #27/#30 (Datenschutz):
-- Nachweis der Einwilligungen (Art. 7 Abs. 1 DSGVO): Zeitpunkt und erfassende Person (Benutzer-ID
-- bzw. `<actor-typ>:<id>`) der letzten Änderung je Einwilligung. Bestand bleibt ohne Nachweis (NULL).
ALTER TABLE members ADD COLUMN IF NOT EXISTS consent_social_media_at timestamptz;
ALTER TABLE members ADD COLUMN IF NOT EXISTS consent_social_media_by text;
ALTER TABLE members ADD COLUMN IF NOT EXISTS consent_website_at timestamptz;
ALTER TABLE members ADD COLUMN IF NOT EXISTS consent_website_by text;
ALTER TABLE members ADD COLUMN IF NOT EXISTS consent_print_at timestamptz;
ALTER TABLE members ADD COLUMN IF NOT EXISTS consent_print_by text;

-- Anonymisierte ehemalige Mitglieder (Löschfrist nach Austritt): Zeile bleibt für Statistiken,
-- ohne Personenbezug.
ALTER TABLE members ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

CREATE INDEX IF NOT EXISTS members_exit_date_idx ON members (exit_date);
