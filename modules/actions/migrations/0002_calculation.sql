-- Modul "actions" Phase 2: Kalkulation (Eckdaten, Posten, Zuschuss-Eingaben)

CREATE TABLE IF NOT EXISTS action_calculations (
	action_id text PRIMARY KEY REFERENCES actions (id) ON DELETE CASCADE,
	participants integer NOT NULL DEFAULT 10 CHECK (participants BETWEEN 0 AND 1000),
	team integer NOT NULL DEFAULT 0 CHECK (team BETWEEN 0 AND 1000),
	nights integer NOT NULL DEFAULT 3 CHECK (nights BETWEEN 0 AND 60),
	buffer_percent numeric(5, 2) NOT NULL DEFAULT 5 CHECK (buffer_percent BETWEEN 0 AND 100),
	include_subsidy boolean NOT NULL DEFAULT false,
	lodging_type text NOT NULL DEFAULT 'external' CHECK (lodging_type IN ('external', 'parish_rooms')),
	konfi boolean NOT NULL DEFAULT false,
	freizeit_type text NOT NULL DEFAULT 'kids' CHECK (freizeit_type IN ('kids', 'youth')),
	bremen_children integer NOT NULL DEFAULT 0 CHECK (bremen_children BETWEEN 0 AND 1000),
	bremen_youth integer NOT NULL DEFAULT 0 CHECK (bremen_youth BETWEEN 0 AND 1000),
	team_with_juleica integer NOT NULL DEFAULT 0 CHECK (team_with_juleica BETWEEN 0 AND 1000),
	team_without_juleica integer NOT NULL DEFAULT 0 CHECK (team_without_juleica BETWEEN 0 AND 1000),
	checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_by text,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calc_items (
	id text PRIMARY KEY,
	action_id text NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
	category text NOT NULL CHECK (category IN (
		'food', 'lodging', 'lodging_extra', 'materials', 'other', 'travel', 'program'
	)),
	label text NOT NULL,
	amount_cents integer NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 100000000),
	basis text NOT NULL CHECK (basis IN ('per_person_night', 'flat')),
	position integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS calc_items_action_idx ON calc_items (action_id, position);
