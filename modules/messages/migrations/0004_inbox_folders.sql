-- Posteingang: eigene Ordner (mit Unterordnern) je Postfach; gemeinsam für alle mit Zugriff auf das Postfach

CREATE TABLE IF NOT EXISTS inbox_folders (
	id text PRIMARY KEY,
	-- personal:<userId> | office:<officeId>:<adresse> | group:<groupId> | stamm (nie unassigned)
	mailbox_key text NOT NULL,
	-- Elternordner im selben Postfach; NULL = oberste Ebene. Löschen nimmt Unterordner mit.
	parent_id text REFERENCES inbox_folders (id) ON DELETE CASCADE,
	name text NOT NULL,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT inbox_folders_name_check CHECK (char_length(name) BETWEEN 1 AND 100)
);

-- Name eindeutig je Ebene (Groß-/Kleinschreibung egal)
CREATE UNIQUE INDEX IF NOT EXISTS inbox_folders_name_unique
	ON inbox_folders (mailbox_key, coalesce(parent_id, ''), lower(name));
CREATE INDEX IF NOT EXISTS inbox_folders_parent_idx ON inbox_folders (parent_id);

-- Ordner der Mail; NULL = Posteingang. Ordner gelöscht → Mail zurück in den Posteingang.
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS folder_id text REFERENCES inbox_folders (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inbox_messages_folder_idx ON inbox_messages (mailbox_key, folder_id, received_at DESC);
