-- Modul "messages": eigene Spam-Erkennung im Posteingang
-- spam_score/spam_reasons = Ergebnis der Bewertung beim Abruf (spam-rules.ts),
-- spam_source = wodurch die Mail Spam ist: server | rules | blocklist | user (NULL = kein Spam bzw. Altbestand)

ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS spam_score integer;
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS spam_reasons jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS spam_source text;
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS spam_marked_by text;
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS spam_marked_at timestamptz;

ALTER TABLE inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_spam_source_check;
ALTER TABLE inbox_messages ADD CONSTRAINT inbox_messages_spam_source_check
	CHECK (spam_source IS NULL OR spam_source IN ('server', 'rules', 'blocklist', 'user'));

-- Altbestand: vom Mailserver markierte Mails
UPDATE inbox_messages SET spam_source = 'server' WHERE spam AND spam_source IS NULL;

-- Massenversand erkennen (Mails je Absender und Zeit)
CREATE INDEX IF NOT EXISTS inbox_messages_from_idx ON inbox_messages (from_address, imported_at);

-- Sperr- und Vertrauensliste (eine für alle Postfächer)
CREATE TABLE IF NOT EXISTS sender_rules (
	id text PRIMARY KEY,
	kind text NOT NULL CHECK (kind IN ('block', 'allow')),
	match_type text NOT NULL CHECK (match_type IN ('address', 'domain')),
	pattern text NOT NULL CHECK (char_length(pattern) BETWEEN 3 AND 254 AND pattern = lower(pattern)),
	note text CHECK (note IS NULL OR char_length(note) <= 200),
	-- manual = in der Verwaltung angelegt, button = über „Spam“/„Kein Spam“ an einer Mail
	origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'button')),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (match_type, pattern)
);
