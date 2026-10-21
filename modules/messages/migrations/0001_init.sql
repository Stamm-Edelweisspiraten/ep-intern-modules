-- Modul "messages" (Nachrichten): E-Mails an Mitglieder und Gruppen mit Verlauf, Empfängerstatus und Anhängen

CREATE TABLE IF NOT EXISTS messages (
	id text PRIMARY KEY,
	subject text NOT NULL,
	body_html text NOT NULL,
	body_text text NOT NULL,
	sender_address text NOT NULL,
	sender_name text,
	reply_to text,
	-- Core-Benutzer ohne FK (anderes Schema)
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	status text NOT NULL DEFAULT 'sending',
	total integer NOT NULL DEFAULT 0,
	sent integer NOT NULL DEFAULT 0,
	failed integer NOT NULL DEFAULT 0,
	completed_at timestamptz,
	CONSTRAINT messages_status_check CHECK (status IN ('sending', 'done', 'partial', 'failed'))
);

CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS messages_created_by_idx ON messages (created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS message_recipients (
	id text PRIMARY KEY,
	message_id text NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
	address text NOT NULL,
	member_id text,
	name text,
	status text NOT NULL DEFAULT 'pending',
	error text,
	attempts integer NOT NULL DEFAULT 0,
	sent_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT message_recipients_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS message_recipients_message_idx ON message_recipients (message_id, status);

CREATE TABLE IF NOT EXISTS message_attachments (
	id text PRIMARY KEY,
	message_id text NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
	filename text NOT NULL,
	content_type text NOT NULL,
	size bigint NOT NULL,
	storage_path text NOT NULL,
	removed_at timestamptz
);

CREATE INDEX IF NOT EXISTS message_attachments_message_idx ON message_attachments (message_id);
