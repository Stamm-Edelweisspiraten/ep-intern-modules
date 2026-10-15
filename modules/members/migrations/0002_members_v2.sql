-- Modul "members" v2: benannte Kontakte, Gruppen mit Wochentag, Farbe und Bild

ALTER TABLE member_phones ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE member_emails ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE groups ADD COLUMN IF NOT EXISTS meeting_weekday smallint
	CHECK (meeting_weekday BETWEEN 1 AND 7);

ALTER TABLE groups ADD COLUMN IF NOT EXISTS color text
	CHECK (color ~ '^#[0-9a-f]{6}$');

ALTER TABLE groups ADD COLUMN IF NOT EXISTS image_path text;

ALTER TABLE groups ADD COLUMN IF NOT EXISTS image_name text;
