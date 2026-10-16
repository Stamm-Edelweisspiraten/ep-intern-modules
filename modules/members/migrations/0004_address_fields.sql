-- Modul "members" v4: Anschrift in Straße, PLZ, Ort und Land aufgeteilt

ALTER TABLE members ADD COLUMN IF NOT EXISTS street text;

ALTER TABLE members ADD COLUMN IF NOT EXISTS postal_code text;

ALTER TABLE members ADD COLUMN IF NOT EXISTS city text;

ALTER TABLE members ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'DE';

-- Bestehende Freitext-Adresse bleibt als "Straße" erhalten (PLZ/Ort werden beim nächsten Bearbeiten ergänzt)
UPDATE members SET street = address WHERE street IS NULL;

ALTER TABLE members ALTER COLUMN address DROP NOT NULL;
