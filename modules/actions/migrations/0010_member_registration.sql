-- Anmeldung mit Mitglied: Login erzwingen, Teilnehmende*r kann einem Mitglied/Konto zugeordnet sein

ALTER TABLE action_forms ADD COLUMN IF NOT EXISTS require_login boolean NOT NULL DEFAULT false;

ALTER TABLE action_participants ADD COLUMN IF NOT EXISTS member_id text;

ALTER TABLE action_participants ADD COLUMN IF NOT EXISTS user_id text;

CREATE UNIQUE INDEX IF NOT EXISTS action_participants_member_idx
	ON action_participants (action_id, member_id) WHERE member_id IS NOT NULL;
