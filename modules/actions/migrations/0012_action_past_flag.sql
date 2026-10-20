-- Aktion liegt bereits in der Vergangenheit (Abrechnung nachtraeglich)
ALTER TABLE actions ADD COLUMN IF NOT EXISTS is_past boolean NOT NULL DEFAULT false;
