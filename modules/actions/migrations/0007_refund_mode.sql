-- Modul "actions": Rueckzahlung mit manueller Personenzahl

ALTER TABLE action_refund_booking ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'auto';

ALTER TABLE action_refund_booking DROP CONSTRAINT IF EXISTS action_refund_booking_mode_check;

ALTER TABLE action_refund_booking ADD CONSTRAINT action_refund_booking_mode_check CHECK (mode IN ('auto', 'manual'));
