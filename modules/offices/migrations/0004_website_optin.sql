-- Issue #27: Inhaber*innen erscheinen auf der Stammeswebsite nur mit ausdrücklicher Zustimmung
-- (Opt-in, Standard aus). show_on_website_at = Zeitpunkt der letzten Änderung (Nachweis).
ALTER TABLE holder_profiles ADD COLUMN IF NOT EXISTS show_on_website boolean NOT NULL DEFAULT false;

ALTER TABLE holder_profiles ADD COLUMN IF NOT EXISTS show_on_website_at timestamptz;
