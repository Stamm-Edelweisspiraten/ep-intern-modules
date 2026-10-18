-- Termine werden der ganzen Galerie zugeordnet statt einzelnen Bildern

CREATE TABLE IF NOT EXISTS gallery_events (
	gallery_id text NOT NULL REFERENCES galleries (id) ON DELETE CASCADE,
	-- event_id = Termin aus `events` (ohne FK, anderes Schema)
	event_id text NOT NULL,
	PRIMARY KEY (gallery_id, event_id)
);

CREATE INDEX IF NOT EXISTS gallery_events_event_idx ON gallery_events (event_id);

-- Bisherige Zuordnungen der Bilder auf ihre Galerie uebernehmen
INSERT INTO gallery_events (gallery_id, event_id)
	SELECT DISTINCT i.gallery_id, ie.event_id
	FROM gallery_image_events ie JOIN gallery_images i ON i.id = ie.image_id
	ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS gallery_image_events;
