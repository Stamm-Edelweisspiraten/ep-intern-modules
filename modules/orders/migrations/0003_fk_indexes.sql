-- Indizes auf Fremdschlüsselspalten der Lagerbewegungen (#73, 07-10): Beim Löschen einer Bestell- bzw.
-- Einkaufsposition (ON DELETE SET NULL) prüft PostgreSQL sonst die ganze Tabelle per Sequential Scan.
CREATE INDEX IF NOT EXISTS stock_movements_order_item_idx ON stock_movements (order_item_id)
	WHERE order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_supplier_item_idx ON stock_movements (supplier_item_id)
	WHERE supplier_item_id IS NOT NULL;
