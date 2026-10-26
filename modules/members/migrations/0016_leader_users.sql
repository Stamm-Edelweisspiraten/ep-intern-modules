-- Modul „members“ v16: Benutzerkonten können eine Gruppe direkt leiten (zusätzlich zu Mitgliedern).
-- Solche Konten erhalten die Rolle „Gruppenleitung“, den Bereich ihrer Gruppen und das Gruppen-Postfach.
-- `user_id` ohne Fremdschlüssel (Core-Tabelle in anderem Schema); `onUserDeleted` räumt auf.

CREATE TABLE IF NOT EXISTS group_leader_users (
	group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	user_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS group_leader_users_user_idx ON group_leader_users (user_id);
