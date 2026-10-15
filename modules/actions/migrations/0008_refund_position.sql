-- Modul "actions": Reihenfolge der Rueckzahlungs-Eintraege (manuell eingegebene Namen)

ALTER TABLE accounting_refunds ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
