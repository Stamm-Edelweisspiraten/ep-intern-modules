-- Material v2.2: Verbrauchsmaterial (Fackeln, Petroleum …) mit Rücknahme und Verbrauch je Reservierung,
-- dazu der Vorrat (Lebensmittel mit Hersteller-Barcode, Chargen mit Mindesthaltbarkeit, Ein-/Ausbuchungen).

-- Verbrauchsmaterial: am Typ; Artikel mit Typ tragen denselben Wert (beim Speichern nachgezogen),
-- Artikel ohne Typ ihren eigenen. Einheit leer = Stück.
ALTER TABLE types ADD COLUMN IF NOT EXISTS consumable boolean NOT NULL DEFAULT false;
ALTER TABLE types ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN IF NOT EXISTS consumable boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT '';

-- Verbrauchsmaterial darf leer werden (Anzahl 0); für anderes Material prüft der Server weiter ≥ 1
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_quantity_check;
ALTER TABLE items ADD CONSTRAINT items_quantity_check CHECK (quantity >= 0);

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS returned_at timestamptz;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS returned_by text;

-- Verbrauch bei der Rücknahme (bleibt als Verlauf, auch wenn Reservierung oder Artikel gelöscht werden)
CREATE TABLE IF NOT EXISTS consumptions (
	id uuid PRIMARY KEY,
	reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
	reservation_title text NOT NULL DEFAULT '',
	item_id uuid REFERENCES items(id) ON DELETE SET NULL,
	item_name text NOT NULL DEFAULT '',
	unit text NOT NULL DEFAULT '',
	quantity integer NOT NULL,
	recorded_by text,
	recorded_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT consumptions_quantity_check CHECK (quantity >= 1)
);
CREATE INDEX IF NOT EXISTS consumptions_reservation_idx ON consumptions (reservation_id);
CREATE INDEX IF NOT EXISTS consumptions_item_idx ON consumptions (item_id);

-- Vorrat: Produkte (ein Hersteller-Barcode je Produkt), Chargen mit MHD, Buchungen
CREATE TABLE IF NOT EXISTS food_products (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	brand text NOT NULL DEFAULT '',
	barcode text UNIQUE,
	unit text NOT NULL DEFAULT '',
	package_size text NOT NULL DEFAULT '',
	location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
	notes text NOT NULL DEFAULT '',
	archived_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT food_products_barcode_check CHECK (barcode IS NULL OR barcode ~ '^[0-9]{8,14}$')
);
CREATE INDEX IF NOT EXISTS food_products_location_idx ON food_products (location_id);

CREATE TABLE IF NOT EXISTS food_batches (
	id uuid PRIMARY KEY,
	product_id uuid NOT NULL REFERENCES food_products(id) ON DELETE CASCADE,
	quantity integer NOT NULL,
	best_before date,
	location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
	expiry_notified_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT food_batches_quantity_check CHECK (quantity >= 0)
);
CREATE INDEX IF NOT EXISTS food_batches_product_idx ON food_batches (product_id);
CREATE INDEX IF NOT EXISTS food_batches_best_before_idx ON food_batches (best_before);

CREATE TABLE IF NOT EXISTS food_movements (
	id uuid PRIMARY KEY,
	product_id uuid NOT NULL REFERENCES food_products(id) ON DELETE CASCADE,
	batch_id uuid REFERENCES food_batches(id) ON DELETE SET NULL,
	kind text NOT NULL,
	quantity integer NOT NULL,
	best_before date,
	note text NOT NULL DEFAULT '',
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT food_movements_kind_check CHECK (kind IN ('in', 'out', 'discard', 'correct')),
	CONSTRAINT food_movements_quantity_check CHECK (quantity >= 1)
);
CREATE INDEX IF NOT EXISTS food_movements_product_idx ON food_movements (product_id, created_at);
