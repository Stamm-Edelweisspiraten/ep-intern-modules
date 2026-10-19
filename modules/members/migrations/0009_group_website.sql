-- Website-Steckbrief je Gruppe (Stammeswebsite, GET /website/groups)
ALTER TABLE groups ADD COLUMN IF NOT EXISTS on_website boolean NOT NULL DEFAULT false;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS website_description text;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS age_range text;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS contact_email text;
CREATE UNIQUE INDEX IF NOT EXISTS groups_slug_idx ON groups (slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS groups_website_idx ON groups (on_website);
