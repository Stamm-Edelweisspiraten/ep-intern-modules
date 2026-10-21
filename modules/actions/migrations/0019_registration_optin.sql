-- Issue #17: Double-Opt-in für anonyme Anmeldungen über den Anmeldelink und Tageslimit für
-- Mails aus öffentlichen Formularen (Anmeldelink, Kosten-Link).

-- Anmeldungen, deren E-Mail-Adresse noch nicht bestätigt ist. Erst die Bestätigung legt die
-- Teilnehmende*n an (danach Rechnung/Anmeldebestätigung). Angaben als ein Chiffrat (payload).
CREATE TABLE IF NOT EXISTS pending_registrations (
	id text PRIMARY KEY,
	action_id text NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	payload text NOT NULL,
	dedupe_key text,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_registrations_action_idx ON pending_registrations (action_id);
CREATE INDEX IF NOT EXISTS pending_registrations_expires_idx ON pending_registrations (expires_at);

-- Zähler je Aktion, Mail-Art und Tag (Obergrenze für Mails an nicht bestätigte Adressen)
CREATE TABLE IF NOT EXISTS public_mail_counters (
	action_id text NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
	kind text NOT NULL,
	day date NOT NULL,
	count integer NOT NULL DEFAULT 0,
	PRIMARY KEY (action_id, kind, day)
);
