-- Erinnerungen: Reservierung VOR dem Versand (Claim-Muster), damit parallele Läufe (Job, Knopf,
-- Doppelklick) je Rechnung und Stufe genau eine automatische Erinnerung verschicken.
-- status 'pending' = reserviert (Versand läuft oder Bestätigung fehlgeschlagen – wird nicht erneut
-- versendet), 'sent' = zugestellt. Fehlgeschlagener Versand löscht die Reservierung wieder.

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'sent';

ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_status_check;

ALTER TABLE reminders ADD CONSTRAINT reminders_status_check CHECK (status IN ('pending', 'sent'));

-- Bestandsdaten: doppelte automatische Erinnerungen gleicher Stufe (aus parallelen Läufen) bleiben
-- als Verlauf erhalten, gelten aber als manuell, damit der Unique-Index angelegt werden kann.
UPDATE reminders r SET manual = true
FROM reminders o
WHERE NOT r.manual AND NOT o.manual AND r.invoice_id = o.invoice_id AND r.level = o.level
	AND (o.sent_at < r.sent_at OR (o.sent_at = r.sent_at AND o.id < r.id));

CREATE UNIQUE INDEX IF NOT EXISTS reminders_auto_level_uq ON reminders (invoice_id, level) WHERE NOT manual;
