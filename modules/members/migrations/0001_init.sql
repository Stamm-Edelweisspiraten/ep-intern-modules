-- Modul "members": Mitglieder und Gruppen (Schema mod_members, unqualifizierte Namen)

CREATE TABLE IF NOT EXISTS groups (
	id text PRIMARY KEY,
	name text NOT NULL UNIQUE,
	type text NOT NULL CHECK (type IN ('sippe', 'meute')),
	description text,
	meeting_place text,
	meeting_time text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
	id text PRIMARY KEY,
	first_name text NOT NULL,
	last_name text NOT NULL,
	scout_name text,
	birth_date date NOT NULL,
	address text NOT NULL,
	stage text NOT NULL CHECK (stage IN (
		'neuling-woelfling', 'woelfling', 'neuling-jungpfadfinder', 'knappe',
		'pfadfinder', 'spaeher', 'kreuzpfadfinder'
	)),
	consent_social_media boolean NOT NULL DEFAULT false,
	consent_website boolean NOT NULL DEFAULT false,
	consent_print boolean NOT NULL DEFAULT false,
	privacy_consent_path text,
	privacy_consent_name text,
	registration_path text,
	registration_name text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS members_name_idx ON members (last_name, first_name);

CREATE TABLE IF NOT EXISTS member_phones (
	id text PRIMARY KEY,
	member_id text NOT NULL REFERENCES members (id) ON DELETE CASCADE,
	value text NOT NULL,
	position integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS member_phones_member_idx ON member_phones (member_id);

CREATE TABLE IF NOT EXISTS member_emails (
	id text PRIMARY KEY,
	member_id text NOT NULL REFERENCES members (id) ON DELETE CASCADE,
	value text NOT NULL,
	position integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS member_emails_member_idx ON member_emails (member_id);

CREATE TABLE IF NOT EXISTS member_groups (
	member_id text NOT NULL REFERENCES members (id) ON DELETE CASCADE,
	group_id text NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
	PRIMARY KEY (member_id, group_id)
);

CREATE INDEX IF NOT EXISTS member_groups_group_idx ON member_groups (group_id);

CREATE TABLE IF NOT EXISTS group_leaders (
	group_id text NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
	member_id text NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
	PRIMARY KEY (group_id, member_id)
);
