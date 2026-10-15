-- Modul "actions": Kalkulation v2 (Basis je Posten, Team-Anteil, Teamer im Zuschuss, Beitrag uebernehmen)

ALTER TABLE calc_items DROP CONSTRAINT IF EXISTS calc_items_basis_check;

ALTER TABLE calc_items ADD CONSTRAINT calc_items_basis_check
	CHECK (basis IN ('flat', 'per_person', 'per_person_night'));

ALTER TABLE action_calculations ADD COLUMN IF NOT EXISTS team_percent numeric(5, 2) NOT NULL DEFAULT 0
	CHECK (team_percent BETWEEN 0 AND 100);

ALTER TABLE action_calculations ADD COLUMN IF NOT EXISTS team_youth integer NOT NULL DEFAULT 0
	CHECK (team_youth BETWEEN 0 AND 1000);

-- Aus der Kalkulation uebernommener Beitrag (Cent); NULL = noch nicht uebernommen
ALTER TABLE actions ADD COLUMN IF NOT EXISTS fee_cents integer
	CHECK (fee_cents IS NULL OR fee_cents >= 0);

ALTER TABLE actions ADD COLUMN IF NOT EXISTS team_fee_cents integer
	CHECK (team_fee_cents IS NULL OR team_fee_cents >= 0);

ALTER TABLE actions ADD COLUMN IF NOT EXISTS fee_applied_at timestamptz;

ALTER TABLE actions ADD COLUMN IF NOT EXISTS fee_applied_by text;
