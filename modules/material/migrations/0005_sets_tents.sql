-- Material v2.1: Sets (zusammengehörige Artikel, z. B. sechs Kohtenbahnen KJ1.1–KJ1.6), Zelte als Bauplan aus
-- Typen und Artikeln, Zelt-Zeilen in Reservierungen mit erzeugten Teil-Zeilen, konkrete Zuteilung von Artikeln
-- zu Typ-Zeilen und die Markierung „ausgegeben“.

CREATE TABLE IF NOT EXISTS sets (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	notes text NOT NULL DEFAULT '',
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE items ADD COLUMN IF NOT EXISTS set_id uuid REFERENCES sets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS items_set_idx ON items (set_id);

CREATE TABLE IF NOT EXISTS tents (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	description text NOT NULL DEFAULT '',
	category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
	archived_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tents_category_idx ON tents (category_id);

CREATE TABLE IF NOT EXISTS tent_parts (
	id uuid PRIMARY KEY,
	tent_id uuid NOT NULL REFERENCES tents(id) ON DELETE CASCADE,
	label text NOT NULL DEFAULT '',
	type_id uuid REFERENCES types(id) ON DELETE RESTRICT,
	item_id uuid REFERENCES items(id) ON DELETE RESTRICT,
	quantity integer NOT NULL,
	from_one_set boolean NOT NULL DEFAULT false,
	position integer NOT NULL DEFAULT 0,
	CONSTRAINT tent_parts_target_check CHECK ((type_id IS NULL) <> (item_id IS NULL)),
	CONSTRAINT tent_parts_quantity_check CHECK (quantity >= 1)
);
CREATE INDEX IF NOT EXISTS tent_parts_tent_idx ON tent_parts (tent_id);
CREATE INDEX IF NOT EXISTS tent_parts_type_idx ON tent_parts (type_id);
CREATE INDEX IF NOT EXISTS tent_parts_item_idx ON tent_parts (item_id);

-- Zelt-Zeilen („2 × Jurte“) belegen selbst nichts; der Server legt Teil-Zeilen mit `parent_line_id` an.
-- `slot_size` = je Zelt so viele Einheiten möglichst aus einem Set (nur Typ-Teil-Zeilen).
ALTER TABLE reservation_lines ADD COLUMN IF NOT EXISTS tent_id uuid REFERENCES tents(id) ON DELETE RESTRICT;
ALTER TABLE reservation_lines ADD COLUMN IF NOT EXISTS parent_line_id uuid
	REFERENCES reservation_lines(id) ON DELETE CASCADE;
ALTER TABLE reservation_lines ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
ALTER TABLE reservation_lines ADD COLUMN IF NOT EXISTS slot_size integer;
CREATE INDEX IF NOT EXISTS reservation_lines_tent_idx ON reservation_lines (tent_id);
CREATE INDEX IF NOT EXISTS reservation_lines_parent_idx ON reservation_lines (parent_line_id);
ALTER TABLE reservation_lines DROP CONSTRAINT IF EXISTS reservation_lines_target_check;
ALTER TABLE reservation_lines ADD CONSTRAINT reservation_lines_target_check CHECK (
	(type_id IS NOT NULL)::int + (item_id IS NOT NULL)::int + (tent_id IS NOT NULL)::int = 1
);
ALTER TABLE reservation_lines DROP CONSTRAINT IF EXISTS reservation_lines_slot_size_check;
ALTER TABLE reservation_lines ADD CONSTRAINT reservation_lines_slot_size_check
	CHECK (slot_size IS NULL OR (slot_size >= 1 AND type_id IS NOT NULL));

-- Konkrete Artikel je Typ-Zeile (automatisch oder von Hand angeheftet); `slot` = Nummer des Zelts
CREATE TABLE IF NOT EXISTS reservation_assignments (
	id uuid PRIMARY KEY,
	reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
	line_id uuid NOT NULL REFERENCES reservation_lines(id) ON DELETE CASCADE,
	item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
	quantity integer NOT NULL,
	pinned boolean NOT NULL DEFAULT false,
	slot integer NOT NULL DEFAULT 0,
	CONSTRAINT reservation_assignments_quantity_check CHECK (quantity >= 1)
);
CREATE INDEX IF NOT EXISTS reservation_assignments_reservation_idx
	ON reservation_assignments (reservation_id);
CREATE INDEX IF NOT EXISTS reservation_assignments_line_idx ON reservation_assignments (line_id);
CREATE INDEX IF NOT EXISTS reservation_assignments_item_idx ON reservation_assignments (item_id);

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS handed_out_at timestamptz;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS handed_out_by text;
