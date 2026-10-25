-- Modul "actions": Freigaben an Principals (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in)
-- statt nur an Benutzer*innen. Bestehende Freigaben bleiben als Typ 'user' erhalten.

ALTER TABLE action_shares ADD COLUMN IF NOT EXISTS principal_type text NOT NULL DEFAULT 'user';

ALTER TABLE action_shares RENAME COLUMN user_id TO principal_id;

ALTER TABLE action_shares DROP CONSTRAINT IF EXISTS action_shares_pkey;

ALTER TABLE action_shares ADD CONSTRAINT action_shares_pkey
	PRIMARY KEY (action_id, principal_type, principal_id);

ALTER TABLE action_shares ALTER COLUMN principal_type DROP DEFAULT;

ALTER TABLE action_shares ADD CONSTRAINT action_shares_principal_type_check
	CHECK (principal_type IN ('everyone', 'group', 'role', 'user', 'member'));

DROP INDEX IF EXISTS action_shares_user_idx;

CREATE INDEX IF NOT EXISTS action_shares_principal_idx ON action_shares (principal_type, principal_id);
