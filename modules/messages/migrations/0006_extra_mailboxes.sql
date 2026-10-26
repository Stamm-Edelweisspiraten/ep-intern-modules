-- Zusätzliche Postfächer (z. B. herbstlager@…), freigegeben an Benutzer, Mitglieder und Gruppen,
-- sowie Weiterleitungen: weitere Adressen, die intern in ein bestehendes Postfach einsortiert werden.

CREATE TABLE IF NOT EXISTS extra_mailboxes (
	id text PRIMARY KEY,
	-- klein geschrieben, eindeutig (auch gegen Weiterleitungen und andere Postfächer, prüft der Dienst)
	address text NOT NULL,
	name text NOT NULL,
	description text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT extra_mailboxes_address_unique UNIQUE (address),
	CONSTRAINT extra_mailboxes_address_check CHECK (address = lower(address) AND char_length(address) BETWEEN 3 AND 254),
	CONSTRAINT extra_mailboxes_name_check CHECK (char_length(name) BETWEEN 1 AND 100)
);

-- Freigaben (Muster <obj>_shares): read = lesen, edit = lesen und als Absender verwenden
CREATE TABLE IF NOT EXISTS extra_mailbox_shares (
	mailbox_id text NOT NULL REFERENCES extra_mailboxes (id) ON DELETE CASCADE,
	principal_type text NOT NULL CHECK (principal_type IN ('group', 'member', 'user')),
	principal_id text NOT NULL,
	level text NOT NULL CHECK (level IN ('read', 'edit')),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (mailbox_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS extra_mailbox_shares_principal_idx
	ON extra_mailbox_shares (principal_type, principal_id);

-- Weiterleitungen: Adresse -> Postfach-Schlüssel (personal:…, office:…, group:…, stamm, extra:…)
CREATE TABLE IF NOT EXISTS mailbox_aliases (
	id text PRIMARY KEY,
	address text NOT NULL,
	target_key text NOT NULL,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT mailbox_aliases_address_unique UNIQUE (address),
	CONSTRAINT mailbox_aliases_address_check CHECK (address = lower(address) AND char_length(address) BETWEEN 3 AND 254)
);

CREATE INDEX IF NOT EXISTS mailbox_aliases_target_idx ON mailbox_aliases (target_key);
