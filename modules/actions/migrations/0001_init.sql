-- Modul "actions": Aktionen, Freigaben und Teilnehmende (Schema mod_actions)

CREATE TABLE IF NOT EXISTS actions (
	id text PRIMARY KEY,
	name text NOT NULL,
	description text,
	location text,
	starts_on date NOT NULL,
	starts_time text,
	ends_on date,
	ends_time text,
	owner_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS actions_owner_idx ON actions (owner_id);
CREATE INDEX IF NOT EXISTS actions_starts_idx ON actions (starts_on DESC);

CREATE TABLE IF NOT EXISTS action_shares (
	action_id text NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
	user_id text NOT NULL,
	level text NOT NULL CHECK (level IN ('read', 'edit')),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (action_id, user_id)
);

CREATE INDEX IF NOT EXISTS action_shares_user_idx ON action_shares (user_id);

CREATE TABLE IF NOT EXISTS action_participants (
	id text PRIMARY KEY,
	action_id text NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
	name text NOT NULL,
	group_label text,
	birth_date date,
	bremen_resident boolean,
	role text NOT NULL DEFAULT 'participant' CHECK (role IN ('participant', 'team')),
	juleica boolean NOT NULL DEFAULT false,
	diet text CHECK (diet IN ('vegetarian', 'vegan', 'meat')),
	allergies text,
	notes text,
	answers jsonb NOT NULL DEFAULT '{}'::jsonb,
	source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'link')),
	consent_accepted_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_participants_action_idx ON action_participants (action_id);
