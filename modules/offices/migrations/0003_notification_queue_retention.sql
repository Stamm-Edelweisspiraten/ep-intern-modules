-- Warteschlange der Tageszusammenfassung: Versuchszähler und Index für das Höchstalter.
-- Einträge werden nach 14 Tagen oder nach 5 fehlgeschlagenen Versandversuchen verworfen
-- (siehe notify.service.ts `sendDigest`).
ALTER TABLE notification_queue ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS notification_queue_created_idx ON notification_queue (created_at);
