-- Material v2 (Neuaufbau, Nutzerentscheidung 2026-10-28): Bestand, Sets, Ausgabe/Rückgabe und Verlauf
-- werden verworfen. Neu: Typen und Lagerartikel (mit Anzahl), flache Lagerorte, Kategorien mit Icon/Farbe,
-- Bilder an Typen oder Artikeln, Reservierungen nach Typ oder Artikel für Aktion/Gruppe/Sonstiges.
-- Erhalten bleiben Codezähler, vorab vergebene Codes, Etikettenformate und Etikett-Layouts.

DROP TABLE IF EXISTS movements;
DROP TABLE IF EXISTS reservation_units;
DROP TABLE IF EXISTS reservation_lines;
DROP TABLE IF EXISTS set_units;
DROP TABLE IF EXISTS sets;
DROP TABLE IF EXISTS set_template_parts;
DROP TABLE IF EXISTS set_templates;
DROP TABLE IF EXISTS container_targets;
DROP TABLE IF EXISTS stock;
DROP TABLE IF EXISTS units;
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS article_images;
DROP TABLE IF EXISTS articles;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS locations;

-- Zähler der entfallenen Code-Arten (Sets, Artikel) werden nicht mehr gebraucht
DELETE FROM code_counters WHERE prefix IN ('S', 'A');

-- Etikett-Layouts auf die neuen Ziele umstellen
ALTER TABLE label_templates DROP CONSTRAINT IF EXISTS label_templates_target_check;
UPDATE label_templates SET target = 'item' WHERE target IN ('unit', 'article', 'set');
UPDATE label_templates
SET layout = replace(replace(layout::text, '{article}', '{type}'), '{total}', '{quantity}')::jsonb
WHERE layout::text LIKE '%{article}%' OR layout::text LIKE '%{total}%';
ALTER TABLE label_templates ADD CONSTRAINT label_templates_target_check
	CHECK (target IN ('item', 'location', 'blank'));

CREATE TABLE IF NOT EXISTS locations (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	description text NOT NULL DEFAULT '',
	code text NOT NULL UNIQUE,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	icon text,
	color text,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT categories_color_check CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT categories_icon_check CHECK (
		icon IS NULL OR (char_length(icon) <= 64 AND icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
	)
);

CREATE TABLE IF NOT EXISTS types (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	description text NOT NULL DEFAULT '',
	notes text NOT NULL DEFAULT '',
	category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
	archived_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS types_category_idx ON types (category_id);

CREATE TABLE IF NOT EXISTS items (
	id uuid PRIMARY KEY,
	type_id uuid REFERENCES types(id) ON DELETE RESTRICT,
	name text NOT NULL,
	category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
	quantity integer NOT NULL DEFAULT 1,
	location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
	code text NOT NULL UNIQUE,
	condition text NOT NULL DEFAULT 'ok',
	condition_note text NOT NULL DEFAULT '',
	condition_reported_by text,
	condition_reported_at timestamptz,
	notes text NOT NULL DEFAULT '',
	archived_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT items_quantity_check CHECK (quantity >= 1),
	CONSTRAINT items_condition_check CHECK (condition IN ('ok', 'worn', 'damaged', 'defect', 'lost'))
);
CREATE INDEX IF NOT EXISTS items_type_idx ON items (type_id);
CREATE INDEX IF NOT EXISTS items_category_idx ON items (category_id);
CREATE INDEX IF NOT EXISTS items_location_idx ON items (location_id);

CREATE TABLE IF NOT EXISTS images (
	id uuid PRIMARY KEY,
	type_id uuid REFERENCES types(id) ON DELETE CASCADE,
	item_id uuid REFERENCES items(id) ON DELETE CASCADE,
	position integer NOT NULL DEFAULT 0,
	width integer NOT NULL DEFAULT 0,
	height integer NOT NULL DEFAULT 0,
	thumb_path text NOT NULL,
	web_path text NOT NULL,
	uploaded_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT images_owner_check CHECK ((type_id IS NULL) <> (item_id IS NULL))
);
CREATE INDEX IF NOT EXISTS images_type_idx ON images (type_id);
CREATE INDEX IF NOT EXISTS images_item_idx ON images (item_id);

CREATE TABLE IF NOT EXISTS reservations (
	id uuid PRIMARY KEY,
	title text NOT NULL,
	purpose text NOT NULL DEFAULT 'other',
	action_id uuid,
	group_id uuid,
	starts_on date NOT NULL,
	ends_on date NOT NULL,
	status text NOT NULL DEFAULT 'reserved',
	notes text NOT NULL DEFAULT '',
	created_by text,
	cancelled_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT reservations_status_check CHECK (status IN ('reserved', 'cancelled')),
	CONSTRAINT reservations_purpose_check CHECK (purpose IN ('action', 'group', 'other')),
	CONSTRAINT reservations_dates_check CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS reservations_action_idx ON reservations (action_id);
CREATE INDEX IF NOT EXISTS reservations_group_idx ON reservations (group_id);
CREATE INDEX IF NOT EXISTS reservations_period_idx ON reservations (starts_on, ends_on);
CREATE INDEX IF NOT EXISTS reservations_created_by_idx ON reservations (created_by);

CREATE TABLE IF NOT EXISTS reservation_lines (
	id uuid PRIMARY KEY,
	reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
	type_id uuid REFERENCES types(id) ON DELETE RESTRICT,
	item_id uuid REFERENCES items(id) ON DELETE RESTRICT,
	quantity integer NOT NULL,
	position integer NOT NULL DEFAULT 0,
	CONSTRAINT reservation_lines_target_check CHECK ((type_id IS NULL) <> (item_id IS NULL)),
	CONSTRAINT reservation_lines_quantity_check CHECK (quantity >= 1)
);
CREATE INDEX IF NOT EXISTS reservation_lines_reservation_idx ON reservation_lines (reservation_id);
CREATE INDEX IF NOT EXISTS reservation_lines_type_idx ON reservation_lines (type_id);
CREATE INDEX IF NOT EXISTS reservation_lines_item_idx ON reservation_lines (item_id);

-- Einmalige Aufräumarbeit: Bilddateien des alten Bestands im Storage (Job `legacy-cleanup`)
CREATE TABLE IF NOT EXISTS legacy_cleanup (
	id text PRIMARY KEY,
	done_at timestamptz
);
INSERT INTO legacy_cleanup (id) VALUES ('v1-images') ON CONFLICT (id) DO NOTHING;
