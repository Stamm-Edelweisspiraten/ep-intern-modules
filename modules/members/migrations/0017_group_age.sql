-- Modul „members“ v17: Altersangabe der Gruppen als Zahlen (von/bis) statt Freitext.
-- `age_range` bleibt als abgeleiteter Anzeigetext (wird beim Speichern aus von/bis gesetzt).
-- Bestand: Freitext nach denselben Regeln wie `messages/age-range.ts` lesen; nicht lesbare Texte bleiben ohne Zahlen.

ALTER TABLE groups ADD COLUMN IF NOT EXISTS age_min smallint;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS age_max smallint;

UPDATE groups g SET age_min = v.mn, age_max = v.mx
FROM (
	SELECT id,
		CASE
			WHEN span IS NOT NULL THEN least(span[1]::int, span[2]::int)
			WHEN frm IS NOT NULL THEN frm[1]::int
			WHEN upto IS NOT NULL THEN NULL
			WHEN one IS NOT NULL THEN one[1]::int
		END AS mn,
		CASE
			WHEN span IS NOT NULL THEN greatest(span[1]::int, span[2]::int)
			WHEN frm IS NOT NULL THEN NULL
			WHEN upto IS NOT NULL THEN upto[1]::int - (CASE WHEN t ~ 'unter' THEN 1 ELSE 0 END)
			WHEN one IS NOT NULL THEN one[1]::int
		END AS mx
	FROM (
		SELECT id, t,
			regexp_match(t, '(\d{1,2})\s*(?:bis|-|–|—|und)\s*(\d{1,2})') AS span,
			coalesce(regexp_match(t, '(?:ab|über|ueber)\s*(\d{1,2})'), regexp_match(t, '(\d{1,2})\s*\+')) AS frm,
			regexp_match(t, '(?:bis|unter)\s*(\d{1,2})') AS upto,
			regexp_match(t, '(\d{1,2})') AS one
		FROM (
			SELECT id, lower(regexp_replace(age_range, '\s+', ' ', 'g')) AS t
			FROM groups
			WHERE age_range IS NOT NULL AND age_min IS NULL AND age_max IS NULL
		) src
	) m
) v
WHERE g.id = v.id AND (v.mn IS NOT NULL OR v.mx IS NOT NULL);

-- „unter 1“ o. Ä. ergäbe negative Werte → verwerfen
UPDATE groups SET age_max = NULL WHERE age_max < 0;

ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_age_range_check;
ALTER TABLE groups ADD CONSTRAINT groups_age_range_check CHECK (
	(age_min IS NULL OR age_min BETWEEN 0 AND 99)
	AND (age_max IS NULL OR age_max BETWEEN 0 AND 99)
	AND (age_min IS NULL OR age_max IS NULL OR age_max >= age_min)
);
