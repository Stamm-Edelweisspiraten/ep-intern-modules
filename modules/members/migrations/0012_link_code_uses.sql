-- Modul "members": Verknuepfungscode nur begrenzt oft nutzbar (#18)
-- `use_count` zaehlt erfolgreiche Verknuepfungen ueber den Brief, `max_uses` ist die beim Erzeugen
-- geltende Hoechstzahl (NULL = aktuelle Einstellung `members.link.maxUses`).

ALTER TABLE member_link_codes ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;
ALTER TABLE member_link_codes ADD COLUMN IF NOT EXISTS max_uses integer;

-- Bestand: Verknuepfungen seit Erzeugung des Codes zaehlen als Nutzung (vorsichtig, inkl. manueller)
UPDATE member_link_codes c SET use_count = (
	SELECT count(*) FROM member_user_links l
	WHERE l.member_id = c.member_id AND l.created_at >= c.created_at
);
