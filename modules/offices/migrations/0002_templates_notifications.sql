-- Ämter aus Modul-Vorlagen und Benachrichtigungen an Inhaber*innen

ALTER TABLE offices ADD COLUMN IF NOT EXISTS source_module text;
ALTER TABLE offices ADD COLUMN IF NOT EXISTS source_key text;

CREATE UNIQUE INDEX IF NOT EXISTS offices_source_idx ON offices (source_module, source_key)
	WHERE source_module IS NOT NULL;

-- Vorlage wurde einmal angelegt; ein gelöschtes Vorlagen-Amt kommt dadurch nicht zurück
CREATE TABLE IF NOT EXISTS office_templates_applied (
	module_id text NOT NULL,
	office_key text NOT NULL,
	applied_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (module_id, office_key)
);

-- Nur Abweichungen vom Standard (sofort) werden gespeichert
CREATE TABLE IF NOT EXISTS notification_prefs (
	user_id text NOT NULL,
	module_id text NOT NULL,
	office_key text NOT NULL,
	event_key text NOT NULL,
	mode text NOT NULL CHECK (mode IN ('immediate', 'daily', 'off')),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, module_id, office_key, event_key)
);

-- Warteschlange für die Tageszusammenfassung
CREATE TABLE IF NOT EXISTS notification_queue (
	id text PRIMARY KEY,
	user_id text NOT NULL,
	module_id text NOT NULL,
	office_key text NOT NULL,
	event_key text NOT NULL,
	subject text NOT NULL,
	text text NOT NULL,
	link text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_queue_user_idx ON notification_queue (user_id, created_at);
