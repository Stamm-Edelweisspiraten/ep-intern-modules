-- Zwischenabrechnungen als unabhaengige Abbilder: jede ZA haelt den gesamten Abrechnungsstand zum Stichtag fest
-- (`snapshot`), Buchungen werden nicht mehr gesperrt. `accounting_interim_entries` = in der ZA enthaltene Buchungen
-- (Freigabe der Auslagen zur Auszahlung in der Kasse). `accounting_entries.interim_id` wird nicht mehr genutzt.

ALTER TABLE accounting_interims ADD COLUMN IF NOT EXISTS snapshot jsonb;

CREATE TABLE IF NOT EXISTS accounting_interim_entries (
	interim_id text NOT NULL REFERENCES accounting_interims (id) ON DELETE CASCADE,
	entry_id text NOT NULL REFERENCES accounting_entries (id) ON DELETE CASCADE,
	PRIMARY KEY (interim_id, entry_id)
);

CREATE INDEX IF NOT EXISTS accounting_interim_entries_entry_idx ON accounting_interim_entries (entry_id);

-- Altdaten: ZA Nr. N enthaelt alle Buchungen der ZA 1..N derselben Aktion (kumulativer Stand)
INSERT INTO accounting_interim_entries (interim_id, entry_id)
	SELECT i.id, e.id
	FROM accounting_interims i
	JOIN accounting_interims j ON j.action_id = i.action_id AND j.number <= i.number
	JOIN accounting_entries e ON e.interim_id = j.id
	ON CONFLICT DO NOTHING;

UPDATE accounting_entries SET interim_id = NULL WHERE interim_id IS NOT NULL;
