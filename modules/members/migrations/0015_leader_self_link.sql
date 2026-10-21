-- Modul „members“ v15: Gruppenleitungen sehen und bearbeiten die Mitglieder ihrer Gruppen.
-- Verknüpfungen gelten auch für Eltern; nur ein ausdrücklich als „eigenes Konto“ markiertes Konto
-- (gesetzt von der Verwaltung, nie über den Brief-Code) zählt als die Person selbst und erhält die
-- automatische Rolle „Gruppenleitung“, wenn das Mitglied eine Gruppe leitet.

ALTER TABLE member_user_links ADD COLUMN IF NOT EXISTS is_self boolean NOT NULL DEFAULT false;

-- Je Konto höchstens ein „eigenes“ Mitglied, je Mitglied höchstens ein eigenes Konto
CREATE UNIQUE INDEX IF NOT EXISTS member_user_links_self_user_idx
	ON member_user_links (user_id) WHERE is_self;
CREATE UNIQUE INDEX IF NOT EXISTS member_user_links_self_member_idx
	ON member_user_links (member_id) WHERE is_self;
