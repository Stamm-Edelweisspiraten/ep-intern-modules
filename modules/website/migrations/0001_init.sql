-- Modul "website" (Inhalte der Stammeswebsite): Banner/Hinweise, FAQ, Blog-Beitraege mit Bildern, Themen und Freigaben

CREATE TABLE IF NOT EXISTS banners (
	id text PRIMARY KEY,
	title text CHECK (title IS NULL OR char_length(title) <= 100),
	text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
	level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'important')),
	placement text NOT NULL DEFAULT 'bar' CHECK (placement IN ('bar', 'home')),
	link_url text CHECK (link_url IS NULL OR char_length(link_url) <= 500),
	link_label text CHECK (link_label IS NULL OR char_length(link_label) <= 60),
	starts_at timestamptz,
	ends_at timestamptz,
	dismissible boolean NOT NULL DEFAULT true,
	active boolean NOT NULL DEFAULT true,
	position integer NOT NULL DEFAULT 0,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT banners_window_check CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS banners_position_idx ON banners (position, created_at);

CREATE TABLE IF NOT EXISTS faqs (
	id text PRIMARY KEY,
	question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 200),
	answer_html text NOT NULL DEFAULT '',
	featured boolean NOT NULL DEFAULT true,
	active boolean NOT NULL DEFAULT true,
	position integer NOT NULL DEFAULT 0,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS faqs_position_idx ON faqs (position, created_at);

-- Startdaten: bisherige Fragen der Website (website/src/lib/faqs.ts, Stand Oktober 2026)
INSERT INTO faqs (id, question, answer_html, featured, active, position) VALUES
	('5b0c7a10-6a43-4c1e-9d0a-0f1a2b3c4d01', 'Wie alt muss ich sein?',
		'<p>Für die Meute: 6–10 Jahre. Für die Sippe: ab 11 Jahren.</p>', true, true, 1),
	('5b0c7a10-6a43-4c1e-9d0a-0f1a2b3c4d02', 'Was kostet das?',
		'<p>Der Jahresbeitrag beträgt aktuell 47 € – Schnuppern ist kostenlos.</p>', true, true, 2),
	('5b0c7a10-6a43-4c1e-9d0a-0f1a2b3c4d03', 'Kann ich mir das mal anschauen?',
		'<p>Klar, komm einfach vorbei! Montags zur Sippe ab 11 Jahren, freitags zur Meute von 7–10 Jahren.</p>', true, true, 3),
	('5b0c7a10-6a43-4c1e-9d0a-0f1a2b3c4d04', 'Was brauche ich?',
		'<p>Bequeme Kleidung, Neugier und Lust auf Abenteuer – das reicht!</p>', true, true, 4)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS posts (
	id text PRIMARY KEY,
	slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 80),
	title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 150),
	teaser text CHECK (teaser IS NULL OR char_length(teaser) <= 300),
	body_html text NOT NULL DEFAULT '',
	status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
	published_at timestamptz,
	-- Titelbild (FK unten, ON DELETE SET NULL)
	cover_image_id text,
	-- Autor*in = Eigentuemer*in (Konto, ohne FK; NULL nach Kontoloeschung)
	author_id text,
	author_name_override text CHECK (author_name_override IS NULL OR char_length(author_name_override) <= 60),
	-- Verknuepfungen in andere Module (ohne FK)
	event_id text,
	gallery_id text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT posts_published_check CHECK (status = 'draft' OR published_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS posts_slug_idx ON posts (slug);
CREATE INDEX IF NOT EXISTS posts_status_idx ON posts (status, published_at DESC);
CREATE INDEX IF NOT EXISTS posts_author_idx ON posts (author_id);

-- Bilder (Titelbild und Bilder im Text); Dateien im Core-Storage (Modul "website"), nur metadatenfreie Varianten
CREATE TABLE IF NOT EXISTS post_images (
	id text PRIMARY KEY,
	post_id text NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
	alt text CHECK (alt IS NULL OR char_length(alt) <= 300),
	width integer NOT NULL,
	height integer NOT NULL,
	size_bytes integer NOT NULL,
	thumb_path text NOT NULL,
	web_path text NOT NULL,
	uploaded_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_images_post_idx ON post_images (post_id, created_at);

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_cover_fk;

ALTER TABLE posts ADD CONSTRAINT posts_cover_fk
	FOREIGN KEY (cover_image_id) REFERENCES post_images (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS posts_cover_idx ON posts (cover_image_id);

-- group_id = Gruppe aus "members" (ohne FK, anderes Schema)
CREATE TABLE IF NOT EXISTS post_groups (
	post_id text NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
	group_id text NOT NULL,
	PRIMARY KEY (post_id, group_id)
);

CREATE INDEX IF NOT EXISTS post_groups_group_idx ON post_groups (group_id);

CREATE TABLE IF NOT EXISTS post_tags (
	post_id text NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
	tag text NOT NULL CHECK (char_length(tag) BETWEEN 1 AND 40),
	position integer NOT NULL DEFAULT 0,
	PRIMARY KEY (post_id, tag)
);

CREATE INDEX IF NOT EXISTS post_tags_tag_idx ON post_tags (lower(tag));

-- Mitschreiben: Freigaben an Principals (nur "edit")
CREATE TABLE IF NOT EXISTS post_shares (
	post_id text NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
	principal_type text NOT NULL CHECK (principal_type IN ('everyone', 'group', 'role', 'user', 'member')),
	principal_id text NOT NULL,
	level text NOT NULL CHECK (level IN ('read', 'edit')),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (post_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS post_shares_principal_idx ON post_shares (principal_type, principal_id);
