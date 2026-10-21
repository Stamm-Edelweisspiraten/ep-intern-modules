-- Aussehen der Nachricht: Stamm-Layout (Kopf, Signatur, Fußzeile) oder einfache Mail wie aus einem Mailprogramm
ALTER TABLE messages ADD COLUMN IF NOT EXISTS layout text NOT NULL DEFAULT 'stamm';
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_layout_check;
ALTER TABLE messages ADD CONSTRAINT messages_layout_check CHECK (layout IN ('stamm', 'plain'));
