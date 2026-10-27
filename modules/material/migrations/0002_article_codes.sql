-- Artikel bekommen einen eigenen Code (A-000001 …): Etiketten und Scannen auch für Mengenartikel
-- (Regalfach „Tassen“). Bestand wird nach Anlagedatum durchnummeriert, der Zähler fortgeschrieben.
-- Etikett-Layouts kennen das Ziel `article`.

ALTER TABLE articles ADD COLUMN IF NOT EXISTS code text;

WITH numbered AS (
	SELECT id, row_number() OVER (ORDER BY created_at, id) AS n
	FROM articles
	WHERE code IS NULL
)
UPDATE articles a
SET code = 'A-' || lpad(((SELECT coalesce(max(value), 0) FROM code_counters WHERE prefix = 'A') + numbered.n)::text, 6, '0')
FROM numbered
WHERE a.id = numbered.id;

INSERT INTO code_counters (prefix, value)
SELECT 'A', count(*) FROM articles
ON CONFLICT (prefix) DO UPDATE SET value = GREATEST(code_counters.value, EXCLUDED.value);

ALTER TABLE articles ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS articles_code_uq ON articles (code);

ALTER TABLE label_templates DROP CONSTRAINT IF EXISTS label_templates_target_check;
ALTER TABLE label_templates ADD CONSTRAINT label_templates_target_check
	CHECK (target IN ('unit', 'set', 'location', 'article', 'blank'));
