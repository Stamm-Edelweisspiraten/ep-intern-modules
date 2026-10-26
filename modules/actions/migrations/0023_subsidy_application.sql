-- Zuschussantrag (Landesjugendpfarramt der BEK): Angaben je Aktion und Geschlecht der Leitungen.
-- Das Geschlecht wird nur für den Antrag erfasst (je Antrag mindestens eine weibliche und eine männliche Leitung).
CREATE TABLE IF NOT EXISTS subsidy_applications (
	action_id text PRIMARY KEY REFERENCES actions(id) ON DELETE CASCADE,
	freizeit_art text NOT NULL DEFAULT '',
	topic text NOT NULL DEFAULT '',
	inclusion boolean NOT NULL DEFAULT false,
	updated_by text,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subsidy_application_leaders (
	action_id text NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
	participant_id text NOT NULL REFERENCES action_participants(id) ON DELETE CASCADE,
	gender text NOT NULL CONSTRAINT subsidy_application_leaders_gender_check CHECK (gender IN ('female', 'male')),
	PRIMARY KEY (action_id, participant_id)
);

CREATE INDEX IF NOT EXISTS subsidy_application_leaders_participant_idx
	ON subsidy_application_leaders (participant_id);
