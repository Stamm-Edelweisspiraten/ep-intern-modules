-- Modul "offices" (Ämter): Ämter mit Reihenfolge, Rollen, E-Mail-Adressen, Inhaber*innen, persönliche Beschreibung

CREATE TABLE IF NOT EXISTS offices (
	id text PRIMARY KEY,
	name text NOT NULL,
	description text,
	position integer NOT NULL DEFAULT 0,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS offices_position_idx ON offices (position, name);

-- role_id = Core-Rolle (ohne FK, anderes Schema); Inhaber*innen erhalten deren Rechte
CREATE TABLE IF NOT EXISTS office_roles (
	office_id text NOT NULL REFERENCES offices (id) ON DELETE CASCADE,
	role_id text NOT NULL,
	PRIMARY KEY (office_id, role_id)
);

CREATE TABLE IF NOT EXISTS office_emails (
	id text PRIMARY KEY,
	office_id text NOT NULL REFERENCES offices (id) ON DELETE CASCADE,
	email text NOT NULL,
	label text,
	position integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS office_emails_office_idx ON office_emails (office_id, position);

CREATE TABLE IF NOT EXISTS office_holders (
	office_id text NOT NULL REFERENCES offices (id) ON DELETE CASCADE,
	user_id text NOT NULL,
	since date,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (office_id, user_id)
);

CREATE INDEX IF NOT EXISTS office_holders_user_idx ON office_holders (user_id);

-- Eine persönliche Beschreibung je Person, gilt für alle ihre Ämter
CREATE TABLE IF NOT EXISTS holder_profiles (
	user_id text PRIMARY KEY,
	bio text,
	updated_at timestamptz NOT NULL DEFAULT now()
);
