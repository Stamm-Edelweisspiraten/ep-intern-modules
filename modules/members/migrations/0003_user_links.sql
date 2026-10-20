-- Modul "members" v3: Verknuepfung von Benutzerkonten mit Mitgliedern (z. B. Eltern <-> Kinder)

CREATE TABLE IF NOT EXISTS member_user_links (
	member_id text NOT NULL REFERENCES members (id) ON DELETE CASCADE,
	user_id text NOT NULL,
	relation text,
	created_at timestamptz NOT NULL DEFAULT now(),
	created_by text,
	PRIMARY KEY (member_id, user_id)
);

CREATE INDEX IF NOT EXISTS member_user_links_user_idx ON member_user_links (user_id);

-- Ein Verknuepfungscode je Mitglied: `token` steht im Link/QR (Kennung, allein wertlos),
-- `code_enc` ist der 6-stellige Code (verschluesselt, fuer erneutes Drucken).
CREATE TABLE IF NOT EXISTS member_link_codes (
	member_id text PRIMARY KEY REFERENCES members (id) ON DELETE CASCADE,
	token text NOT NULL UNIQUE,
	code_enc text NOT NULL,
	expires_at timestamptz NOT NULL,
	failed_attempts integer NOT NULL DEFAULT 0,
	locked_until timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	created_by text
);
