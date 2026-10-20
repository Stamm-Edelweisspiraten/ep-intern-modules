-- Modul "members" v8: abschaltbare Mail-Kategorien je Mitglied (nur Abwahlen werden gespeichert)

CREATE TABLE IF NOT EXISTS member_mail_prefs (
	member_id text NOT NULL REFERENCES members (id) ON DELETE CASCADE,
	category text NOT NULL CHECK (category IN ('payment-confirmation', 'action-info')),
	enabled boolean NOT NULL DEFAULT false,
	updated_at timestamptz NOT NULL DEFAULT now(),
	updated_by text,
	PRIMARY KEY (member_id, category)
);
