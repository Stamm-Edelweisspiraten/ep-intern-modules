-- Modul material: Lagerorte, Kategorien, Artikel, Einzelstücke/Kisten, Mengenbestand, Sets,
-- Reservierungen mit Ausgabe/Rückgabe, Verlauf, Etiketten.

CREATE TABLE IF NOT EXISTS code_counters (
	prefix text PRIMARY KEY,
	value integer NOT NULL DEFAULT 0
);

-- Vorab vergebene Codes (Leer-Etiketten), bis sie einem Stück/Set/Ort zugewiesen werden
CREATE TABLE IF NOT EXISTS reserved_codes (
	code text PRIMARY KEY,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
	id uuid PRIMARY KEY,
	parent_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
	name text NOT NULL,
	description text NOT NULL DEFAULT '',
	code text NOT NULL UNIQUE,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT locations_parent_check CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS locations_parent_idx ON locations (parent_id);

CREATE TABLE IF NOT EXISTS categories (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	color text,
	icon text,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT categories_color_check CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$')
);

CREATE TABLE IF NOT EXISTS articles (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
	kind text NOT NULL,
	unit_label text NOT NULL DEFAULT 'Stück',
	description text NOT NULL DEFAULT '',
	notes text NOT NULL DEFAULT '',
	min_quantity integer NOT NULL DEFAULT 0,
	archived_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT articles_kind_check CHECK (kind IN ('unit', 'bulk')),
	CONSTRAINT articles_min_quantity_check CHECK (min_quantity >= 0)
);
CREATE INDEX IF NOT EXISTS articles_category_idx ON articles (category_id);

CREATE TABLE IF NOT EXISTS article_images (
	id uuid PRIMARY KEY,
	article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
	position integer NOT NULL DEFAULT 0,
	width integer NOT NULL DEFAULT 0,
	height integer NOT NULL DEFAULT 0,
	thumb_path text NOT NULL,
	web_path text NOT NULL,
	uploaded_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS article_images_article_idx ON article_images (article_id);

CREATE TABLE IF NOT EXISTS reservations (
	id uuid PRIMARY KEY,
	title text NOT NULL,
	action_id uuid,
	starts_on date NOT NULL,
	ends_on date NOT NULL,
	status text NOT NULL DEFAULT 'reserved',
	notes text NOT NULL DEFAULT '',
	created_by text,
	issued_at timestamptz,
	issued_by text,
	returned_at timestamptz,
	returned_by text,
	overdue_notified_on date,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT reservations_status_check CHECK (status IN ('reserved', 'issued', 'returned', 'cancelled')),
	CONSTRAINT reservations_dates_check CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS reservations_action_idx ON reservations (action_id);
CREATE INDEX IF NOT EXISTS reservations_period_idx ON reservations (starts_on, ends_on);
CREATE INDEX IF NOT EXISTS reservations_created_by_idx ON reservations (created_by);

CREATE TABLE IF NOT EXISTS units (
	id uuid PRIMARY KEY,
	article_id uuid NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
	code text NOT NULL UNIQUE,
	label text NOT NULL DEFAULT '',
	is_container boolean NOT NULL DEFAULT false,
	container_id uuid REFERENCES units(id) ON DELETE SET NULL,
	location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
	condition text NOT NULL DEFAULT 'ok',
	condition_note text NOT NULL DEFAULT '',
	purchased_on date,
	value_cents bigint,
	notes text NOT NULL DEFAULT '',
	retired_at timestamptz,
	issued_reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT units_condition_check CHECK (condition IN ('ok', 'worn', 'damaged', 'defect', 'lost')),
	CONSTRAINT units_place_check CHECK (container_id IS NULL OR location_id IS NULL),
	CONSTRAINT units_container_self_check CHECK (container_id IS NULL OR container_id <> id),
	CONSTRAINT units_value_check CHECK (value_cents IS NULL OR value_cents >= 0)
);
CREATE INDEX IF NOT EXISTS units_article_idx ON units (article_id);
CREATE INDEX IF NOT EXISTS units_container_idx ON units (container_id);
CREATE INDEX IF NOT EXISTS units_location_idx ON units (location_id);
CREATE INDEX IF NOT EXISTS units_issued_idx ON units (issued_reservation_id);

CREATE TABLE IF NOT EXISTS stock (
	id uuid PRIMARY KEY,
	article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
	location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
	container_id uuid REFERENCES units(id) ON DELETE RESTRICT,
	quantity integer NOT NULL DEFAULT 0,
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT stock_holder_check CHECK ((location_id IS NULL) <> (container_id IS NULL)),
	CONSTRAINT stock_quantity_check CHECK (quantity >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_location_uq ON stock (article_id, location_id) WHERE location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_container_uq ON stock (article_id, container_id) WHERE container_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_location_idx ON stock (location_id);
CREATE INDEX IF NOT EXISTS stock_container_idx ON stock (container_id);

CREATE TABLE IF NOT EXISTS container_targets (
	container_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
	article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
	quantity integer NOT NULL,
	PRIMARY KEY (container_id, article_id),
	CONSTRAINT container_targets_quantity_check CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS container_targets_article_idx ON container_targets (article_id);

CREATE TABLE IF NOT EXISTS set_templates (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	description text NOT NULL DEFAULT '',
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS set_template_parts (
	template_id uuid NOT NULL REFERENCES set_templates(id) ON DELETE CASCADE,
	article_id uuid NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
	quantity integer NOT NULL,
	position integer NOT NULL DEFAULT 0,
	PRIMARY KEY (template_id, article_id),
	CONSTRAINT set_template_parts_quantity_check CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS set_template_parts_article_idx ON set_template_parts (article_id);

CREATE TABLE IF NOT EXISTS sets (
	id uuid PRIMARY KEY,
	template_id uuid NOT NULL REFERENCES set_templates(id) ON DELETE RESTRICT,
	name text NOT NULL,
	code text NOT NULL UNIQUE,
	notes text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sets_template_idx ON sets (template_id);

CREATE TABLE IF NOT EXISTS set_units (
	set_id uuid NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
	unit_id uuid NOT NULL UNIQUE REFERENCES units(id) ON DELETE CASCADE,
	PRIMARY KEY (set_id, unit_id)
);

CREATE TABLE IF NOT EXISTS reservation_lines (
	id uuid PRIMARY KEY,
	reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
	kind text NOT NULL,
	unit_id uuid REFERENCES units(id) ON DELETE CASCADE,
	set_id uuid REFERENCES sets(id) ON DELETE CASCADE,
	article_id uuid REFERENCES articles(id) ON DELETE CASCADE,
	quantity integer NOT NULL DEFAULT 1,
	issued_qty integer NOT NULL DEFAULT 0,
	returned_qty integer NOT NULL DEFAULT 0,
	position integer NOT NULL DEFAULT 0,
	CONSTRAINT reservation_lines_kind_check CHECK (
		(kind = 'unit' AND unit_id IS NOT NULL AND set_id IS NULL AND article_id IS NULL)
		OR (kind = 'set' AND set_id IS NOT NULL AND unit_id IS NULL AND article_id IS NULL)
		OR (kind = 'article' AND article_id IS NOT NULL AND unit_id IS NULL AND set_id IS NULL)
	),
	CONSTRAINT reservation_lines_qty_check CHECK (
		quantity > 0 AND issued_qty >= 0 AND returned_qty >= 0 AND returned_qty <= issued_qty
	)
);
CREATE INDEX IF NOT EXISTS reservation_lines_reservation_idx ON reservation_lines (reservation_id);
CREATE INDEX IF NOT EXISTS reservation_lines_unit_idx ON reservation_lines (unit_id);
CREATE INDEX IF NOT EXISTS reservation_lines_set_idx ON reservation_lines (set_id);
CREATE INDEX IF NOT EXISTS reservation_lines_article_idx ON reservation_lines (article_id);

-- Tatsächlich ausgegebene Stücke (auch Inhalt von Kisten und Zuteilungen zu Artikel-Zeilen)
CREATE TABLE IF NOT EXISTS reservation_units (
	reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
	unit_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
	line_id uuid REFERENCES reservation_lines(id) ON DELETE SET NULL,
	issued_at timestamptz NOT NULL DEFAULT now(),
	issued_by text,
	returned_at timestamptz,
	returned_by text,
	return_condition text,
	return_note text NOT NULL DEFAULT '',
	PRIMARY KEY (reservation_id, unit_id),
	CONSTRAINT reservation_units_condition_check CHECK (
		return_condition IS NULL OR return_condition IN ('ok', 'worn', 'damaged', 'defect', 'lost')
	)
);
CREATE INDEX IF NOT EXISTS reservation_units_unit_idx ON reservation_units (unit_id);
CREATE INDEX IF NOT EXISTS reservation_units_line_idx ON reservation_units (line_id);

CREATE TABLE IF NOT EXISTS movements (
	id uuid PRIMARY KEY,
	kind text NOT NULL,
	unit_id uuid REFERENCES units(id) ON DELETE CASCADE,
	article_id uuid REFERENCES articles(id) ON DELETE CASCADE,
	quantity integer,
	detail text NOT NULL DEFAULT '',
	note text NOT NULL DEFAULT '',
	reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
	actor_id text,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movements_unit_idx ON movements (unit_id, created_at);
CREATE INDEX IF NOT EXISTS movements_article_idx ON movements (article_id, created_at);
CREATE INDEX IF NOT EXISTS movements_reservation_idx ON movements (reservation_id);

CREATE TABLE IF NOT EXISTS label_formats (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	format jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS label_templates (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	target text NOT NULL,
	layout jsonb NOT NULL,
	format_key text NOT NULL,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT label_templates_target_check CHECK (target IN ('unit', 'set', 'location', 'blank'))
);
