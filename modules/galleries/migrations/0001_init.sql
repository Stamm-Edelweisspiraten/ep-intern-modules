-- Modul "galleries" (Bilder / Galerien): Galerien, Bilder, Termin-Zuordnung, Freigaben an Principals

CREATE TABLE IF NOT EXISTS galleries (
	id text PRIMARY KEY,
	title text NOT NULL,
	description text,
	visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
	-- gesetztes Titelbild; NULL = aeltestes Bild gilt (FK unten, ON DELETE SET NULL)
	cover_image_id text,
	owner_id text NOT NULL,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS galleries_owner_idx ON galleries (owner_id);
CREATE INDEX IF NOT EXISTS galleries_visibility_idx ON galleries (visibility);

-- Dateien liegen im Core-Storage (Modul "galleries"), Pfade je Variante; nur metadatenfreie Varianten
CREATE TABLE IF NOT EXISTS gallery_images (
	id text PRIMARY KEY,
	gallery_id text NOT NULL REFERENCES galleries (id) ON DELETE CASCADE,
	description text,
	position integer NOT NULL DEFAULT 0,
	original_name text NOT NULL,
	content_type text NOT NULL,
	width integer NOT NULL,
	height integer NOT NULL,
	size_bytes integer NOT NULL,
	thumb_path text NOT NULL,
	web_path text NOT NULL,
	full_path text NOT NULL,
	uploaded_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gallery_images_gallery_idx ON gallery_images (gallery_id, created_at, id);

ALTER TABLE galleries DROP CONSTRAINT IF EXISTS galleries_cover_fk;

ALTER TABLE galleries ADD CONSTRAINT galleries_cover_fk
	FOREIGN KEY (cover_image_id) REFERENCES gallery_images (id) ON DELETE SET NULL;

-- event_id = Termin aus `events` (ohne FK, anderes Schema)
CREATE TABLE IF NOT EXISTS gallery_image_events (
	image_id text NOT NULL REFERENCES gallery_images (id) ON DELETE CASCADE,
	event_id text NOT NULL,
	PRIMARY KEY (image_id, event_id)
);

CREATE INDEX IF NOT EXISTS gallery_image_events_event_idx ON gallery_image_events (event_id);

CREATE TABLE IF NOT EXISTS gallery_shares (
	gallery_id text NOT NULL REFERENCES galleries (id) ON DELETE CASCADE,
	principal_type text NOT NULL CHECK (principal_type IN ('everyone', 'group', 'role', 'user', 'member')),
	principal_id text NOT NULL,
	level text NOT NULL CHECK (level IN ('read', 'edit')),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (gallery_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS gallery_shares_principal_idx ON gallery_shares (principal_type, principal_id);
