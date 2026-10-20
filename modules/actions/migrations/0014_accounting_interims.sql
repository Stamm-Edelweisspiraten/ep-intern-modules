-- Zwischenabrechnungen: Teilabschluss der bisherigen Buchungen (gesperrt, Auslagen gehen sofort an die Kasse).
-- Die Aktion bleibt offen; neue Buchungen landen in der naechsten Zwischen- bzw. der Schlussabrechnung.

CREATE TABLE IF NOT EXISTS accounting_interims (
	id text PRIMARY KEY,
	action_id text NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
	number integer NOT NULL CHECK (number > 0),
	note text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (action_id, number)
);

CREATE INDEX IF NOT EXISTS accounting_interims_action_idx ON accounting_interims (action_id, number);

-- NULL = noch in keiner Zwischenabrechnung (offen bzw. Schlussabrechnung)
ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS interim_id text REFERENCES accounting_interims (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS accounting_entries_interim_idx ON accounting_entries (interim_id);
