-- Modul "offices" v5 (#73): Laenge der persoenlichen Beschreibung als Rueckhalt zur Zod-Pruefung (MAX_BIO = 2000).
-- Erst Altbestand kuerzen, dann CHECK anlegen und validieren.

UPDATE holder_profiles SET bio = left(bio, 2000) WHERE bio IS NOT NULL AND char_length(bio) > 2000;

ALTER TABLE holder_profiles DROP CONSTRAINT IF EXISTS holder_profiles_bio_check;
ALTER TABLE holder_profiles ADD CONSTRAINT holder_profiles_bio_check
	CHECK (bio IS NULL OR char_length(bio) <= 2000) NOT VALID;

ALTER TABLE holder_profiles VALIDATE CONSTRAINT holder_profiles_bio_check;
