-- Posteingang: Mails aus dem Catch-all-Postfach (IMAP), zugeordnet zu persönlichen, Amts-, Gruppen- und Stamm-Postfächern

CREATE TABLE IF NOT EXISTS inbox_messages (
	id text PRIMARY KEY,
	-- personal:<userId> | office:<officeId>:<adresse> | group:<groupId> | stamm | unassigned
	mailbox_key text NOT NULL,
	-- Adresse, an die die Mail ging (bei unassigned die erste Adresse der eigenen Domain)
	mailbox_address text NOT NULL,
	-- Message-ID oder Hash des Rohtexts: verhindert Doppelimporte je Postfach
	dedupe_key text NOT NULL,
	message_id_header text,
	in_reply_to text,
	-- Message-IDs des Verlaufs, durch Leerzeichen getrennt
	references_list text,
	thread_id text NOT NULL,
	from_address text NOT NULL,
	from_name text,
	reply_to text,
	to_list jsonb NOT NULL DEFAULT '[]'::jsonb,
	cc_list jsonb NOT NULL DEFAULT '[]'::jsonb,
	subject text NOT NULL DEFAULT '',
	body_html text NOT NULL DEFAULT '',
	body_text text NOT NULL DEFAULT '',
	received_at timestamptz NOT NULL,
	imported_at timestamptz NOT NULL DEFAULT now(),
	size bigint NOT NULL DEFAULT 0,
	spam boolean NOT NULL DEFAULT false,
	auto_submitted boolean NOT NULL DEFAULT false,
	auth_result text NOT NULL DEFAULT 'none',
	-- Warum nicht zugeordnet: unknown | ambiguous
	unassigned_reason text,
	-- Inhalt nicht übernommen (zu groß/unlesbar)
	truncated boolean NOT NULL DEFAULT false,
	-- Anhänge, die nicht gespeichert werden konnten (Dateityp nicht erlaubt), nur Name/Typ/Größe
	skipped_attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
	-- Externe Bilder, die aus Datenschutzgründen entfernt wurden (Hinweis in der Ansicht)
	blocked_images integer NOT NULL DEFAULT 0,
	deleted_at timestamptz,
	deleted_by text,
	CONSTRAINT inbox_messages_auth_check CHECK (auth_result IN ('pass', 'fail', 'none')),
	CONSTRAINT inbox_messages_reason_check CHECK (unassigned_reason IS NULL OR unassigned_reason IN ('unknown', 'ambiguous')),
	CONSTRAINT inbox_messages_dedupe_unique UNIQUE (mailbox_key, dedupe_key)
);

CREATE INDEX IF NOT EXISTS inbox_messages_mailbox_idx ON inbox_messages (mailbox_key, received_at DESC);
CREATE INDEX IF NOT EXISTS inbox_messages_thread_idx ON inbox_messages (thread_id);
CREATE INDEX IF NOT EXISTS inbox_messages_message_id_idx ON inbox_messages (message_id_header);
CREATE INDEX IF NOT EXISTS inbox_messages_deleted_idx ON inbox_messages (deleted_at);

CREATE TABLE IF NOT EXISTS inbox_attachments (
	id text PRIMARY KEY,
	inbox_message_id text NOT NULL REFERENCES inbox_messages (id) ON DELETE CASCADE,
	filename text NOT NULL,
	content_type text NOT NULL,
	size bigint NOT NULL,
	content_id text,
	inline boolean NOT NULL DEFAULT false,
	storage_path text NOT NULL
);

CREATE INDEX IF NOT EXISTS inbox_attachments_message_idx ON inbox_attachments (inbox_message_id);

-- Gelesen-Status je Person (gemeinsame Postfächer: jede Person für sich)
CREATE TABLE IF NOT EXISTS inbox_reads (
	inbox_message_id text NOT NULL REFERENCES inbox_messages (id) ON DELETE CASCADE,
	user_id text NOT NULL,
	read_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (inbox_message_id, user_id)
);

CREATE INDEX IF NOT EXISTS inbox_reads_user_idx ON inbox_reads (user_id);

-- Benachrichtigungen je Person, Postfach und Ereignis; gespeichert werden nur Abweichungen vom Standard (an)
CREATE TABLE IF NOT EXISTS inbox_notification_prefs (
	user_id text NOT NULL,
	mailbox_key text NOT NULL,
	event text NOT NULL,
	enabled boolean NOT NULL,
	PRIMARY KEY (user_id, mailbox_key, event),
	CONSTRAINT inbox_notification_prefs_event_check CHECK (event IN ('new', 'replied'))
);

-- Letzter Abruf des Catch-all-Postfachs (eine Zeile, für die Anzeige in der Oberfläche)
CREATE TABLE IF NOT EXISTS inbox_poll_state (
	id integer PRIMARY KEY DEFAULT 1,
	last_at timestamptz,
	status text,
	message text,
	CONSTRAINT inbox_poll_state_single CHECK (id = 1),
	CONSTRAINT inbox_poll_state_status_check CHECK (status IS NULL OR status IN ('ok', 'error'))
);

-- Gesendete Nachrichten: Antworten/Weiterleitungen aus dem Posteingang und Message-IDs für die Zuordnung von Antworten
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mailbox_key text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_of text REFERENCES inbox_messages (id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forward_of text REFERENCES inbox_messages (id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS in_reply_to text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS references_list text;
ALTER TABLE message_recipients ADD COLUMN IF NOT EXISTS message_id_header text;

CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id);
CREATE INDEX IF NOT EXISTS messages_reply_of_idx ON messages (reply_of);
CREATE INDEX IF NOT EXISTS messages_forward_of_idx ON messages (forward_of);
CREATE INDEX IF NOT EXISTS message_recipients_message_id_idx ON message_recipients (message_id_header);
