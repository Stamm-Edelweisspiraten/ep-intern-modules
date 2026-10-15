-- Modul "actions": Zuschussberechtigung je Person (NULL = automatisch aus Alter und Wohnort)

ALTER TABLE action_participants ADD COLUMN IF NOT EXISTS subsidy_eligible boolean;
