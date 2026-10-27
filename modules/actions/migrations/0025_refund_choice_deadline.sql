-- Modul "actions": Frist fuer die Rueckmeldung (Spende/Auszahlung) zur Rueckzahlung.
-- Bis einschliesslich dieses Tages ist die Wahl ueber den Link offen und die Kasse zahlt noch nicht aus;
-- danach gilt fuer alle ohne Rueckmeldung "auszahlen". NULL = keine Frist (sofort auszahlbar).

ALTER TABLE action_refund_booking ADD COLUMN IF NOT EXISTS choice_deadline date;
