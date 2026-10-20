-- Merker für die tägliche Fehlmengen-Meldung an das Amt „Kämmerer*in“: zuletzt gemeldeter Stand
-- (Fingerabdruck aus Variante und Fehlmenge), damit unveränderte Fehlmengen nicht täglich erneut gemeldet werden.
CREATE TABLE IF NOT EXISTS digest_state (
	key text PRIMARY KEY,
	fingerprint text NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);
