-- Auslage beim Erfassen bereits erstattet (bleibt erstattet, wenn eine Kassen-Zahlung zurueckgenommen wird)
ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS reimbursed_upfront boolean NOT NULL DEFAULT false;
