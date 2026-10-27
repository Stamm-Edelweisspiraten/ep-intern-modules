-- Set-Typen dürfen Mengenartikel enthalten (z. B. 20 Heringe je Kohte). Beim Reservieren eines Sets
-- legt der Server dafür eigene Mengen-Zeilen an und merkt sich, aus welchem Set sie stammen.
ALTER TABLE reservation_lines ADD COLUMN IF NOT EXISTS source_set_id uuid;
CREATE INDEX IF NOT EXISTS reservation_lines_source_set_idx ON reservation_lines (source_set_id);
