-- Modul "orders" (Bestellungen / Kaemmerer*in): Artikel mit Groessen und Bildern, Bestellungen von
-- Mitgliedern, Lager (Bewegungen), Lieferantenbestellungen mit Teillieferung. Rechnungen/Auszahlungen
-- liegen in der Kasse (Modul "treasury", Schluessel order:<id> bzw. order-supplier:<id>).

CREATE TABLE IF NOT EXISTS articles (
	id text PRIMARY KEY,
	title text NOT NULL,
	description text,
	notes text,
	reorder_url text,
	active boolean NOT NULL DEFAULT true,
	position integer NOT NULL DEFAULT 0,
	archived_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS articles_position_idx ON articles (position, title);

-- Jeder Artikel hat mindestens eine Variante; ohne Groessen genau eine mit label = ''
CREATE TABLE IF NOT EXISTS article_variants (
	id text PRIMARY KEY,
	article_id text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
	label text NOT NULL DEFAULT '',
	price_cents integer NOT NULL CHECK (price_cents >= 0),
	reorder_url text,
	stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
	min_stock integer NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
	position integer NOT NULL DEFAULT 0,
	archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS article_variants_article_idx ON article_variants (article_id, position);

CREATE TABLE IF NOT EXISTS article_images (
	id text PRIMARY KEY,
	article_id text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
	position integer NOT NULL DEFAULT 0,
	width integer NOT NULL,
	height integer NOT NULL,
	thumb_path text NOT NULL,
	web_path text NOT NULL,
	uploaded_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS article_images_article_idx ON article_images (article_id, position);

-- member_id = Mitglied aus "members" (ohne FK, anderes Schema); member_name als Snapshot
CREATE TABLE IF NOT EXISTS orders (
	id text PRIMARY KEY,
	number text NOT NULL UNIQUE,
	year integer NOT NULL,
	seq integer NOT NULL,
	member_id text NOT NULL,
	member_name text NOT NULL,
	ordered_by text,
	note text,
	invoice_id text,
	invoice_number text,
	-- letzter erfolgreicher Abgleich mit der Kasse; NULL = Rechnung steht aus (Job)
	treasury_synced_at timestamptz,
	-- Positionen geaendert, Kasse noch nicht nachgezogen
	treasury_dirty boolean NOT NULL DEFAULT true,
	cancelled_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (year, seq)
);

CREATE INDEX IF NOT EXISTS orders_member_idx ON orders (member_id);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
	id text PRIMARY KEY,
	order_id text NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
	variant_id text NOT NULL REFERENCES article_variants (id),
	position integer NOT NULL DEFAULT 0,
	article_title text NOT NULL,
	variant_label text NOT NULL DEFAULT '',
	unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
	quantity integer NOT NULL CHECK (quantity > 0),
	delivered_qty integer NOT NULL DEFAULT 0 CHECK (delivered_qty >= 0),
	cancelled_qty integer NOT NULL DEFAULT 0 CHECK (cancelled_qty >= 0),
	CHECK (delivered_qty + cancelled_qty <= quantity)
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id, position);
CREATE INDEX IF NOT EXISTS order_items_variant_idx ON order_items (variant_id);

CREATE TABLE IF NOT EXISTS supplier_orders (
	id text PRIMARY KEY,
	number text NOT NULL UNIQUE,
	year integer NOT NULL,
	seq integer NOT NULL,
	supplier text NOT NULL,
	ordered_on date NOT NULL,
	note text,
	-- Lieferantenrechnung (Auszahlung in der Kasse unter payable_ref)
	invoice_amount_cents integer CHECK (invoice_amount_cents > 0),
	invoice_recipient text,
	payable_ref text UNIQUE,
	payable_synced_at timestamptz,
	closed_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (year, seq)
);

CREATE INDEX IF NOT EXISTS supplier_orders_ordered_idx ON supplier_orders (ordered_on DESC);

CREATE TABLE IF NOT EXISTS supplier_order_items (
	id text PRIMARY KEY,
	supplier_order_id text NOT NULL REFERENCES supplier_orders (id) ON DELETE CASCADE,
	variant_id text NOT NULL REFERENCES article_variants (id),
	position integer NOT NULL DEFAULT 0,
	article_title text NOT NULL,
	variant_label text NOT NULL DEFAULT '',
	quantity integer NOT NULL CHECK (quantity > 0),
	received_qty integer NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
	cancelled_qty integer NOT NULL DEFAULT 0 CHECK (cancelled_qty >= 0),
	unit_cost_cents integer CHECK (unit_cost_cents >= 0),
	CHECK (received_qty + cancelled_qty <= quantity)
);

CREATE INDEX IF NOT EXISTS supplier_order_items_order_idx ON supplier_order_items (supplier_order_id, position);
CREATE INDEX IF NOT EXISTS supplier_order_items_variant_idx ON supplier_order_items (variant_id);

-- Lagerbewegungen; Bestand steht fortgeschrieben in article_variants.stock (gleiche Transaktion)
CREATE TABLE IF NOT EXISTS stock_movements (
	id text PRIMARY KEY,
	variant_id text NOT NULL REFERENCES article_variants (id) ON DELETE CASCADE,
	delta integer NOT NULL,
	kind text NOT NULL CHECK (kind IN ('receipt', 'handout', 'correction', 'return')),
	order_item_id text REFERENCES order_items (id) ON DELETE SET NULL,
	supplier_item_id text REFERENCES supplier_order_items (id) ON DELETE SET NULL,
	note text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_movements_variant_idx ON stock_movements (variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_created_idx ON stock_movements (created_at DESC);
