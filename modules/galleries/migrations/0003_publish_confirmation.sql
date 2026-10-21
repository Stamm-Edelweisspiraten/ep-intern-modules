-- Issue #27: Veröffentlichen einer Galerie verlangt eine dokumentierte Bestätigung, dass für alle
-- erkennbaren Personen eine Website-Einwilligung vorliegt (Zeitpunkt und bestätigende Person).
-- Die Werte bleiben beim Zurückstellen auf „privat“ als Historie erhalten.
ALTER TABLE galleries ADD COLUMN IF NOT EXISTS public_confirmed_at timestamptz;

ALTER TABLE galleries ADD COLUMN IF NOT EXISTS public_confirmed_by text;
