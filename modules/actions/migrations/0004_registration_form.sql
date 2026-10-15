-- Modul "actions" Phase 3: Anmeldeformular (Link) und Eingaenge als Teilnehmende

CREATE TABLE IF NOT EXISTS action_forms (
	action_id text PRIMARY KEY REFERENCES actions (id) ON DELETE CASCADE,
	token text NOT NULL UNIQUE,
	enabled boolean NOT NULL DEFAULT false,
	opens_at timestamptz,
	closes_at timestamptz,
	max_participants integer CHECK (max_participants IS NULL OR max_participants BETWEEN 1 AND 1000),
	definition jsonb NOT NULL,
	intro text,
	disclaimer_template text NOT NULL DEFAULT '',
	privacy_url text,
	updated_by text,
	updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE action_participants ADD COLUMN IF NOT EXISTS contact_email text;

-- normalisierter Name + Geburtsdatum der Anmeldungen ueber den Link (Duplikatschutz)
ALTER TABLE action_participants ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS action_participants_dedupe_idx
	ON action_participants (action_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
