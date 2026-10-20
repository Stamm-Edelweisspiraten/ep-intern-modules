-- Modul "members" v5: Zusatzfelder am Mitglied (vordefinierte Vorlagen + eigene Felder)

CREATE TABLE IF NOT EXISTS member_field_defs (
	key text PRIMARY KEY,
	position integer NOT NULL DEFAULT 0,
	active boolean NOT NULL DEFAULT true,
	preset boolean NOT NULL DEFAULT false,
	definition jsonb NOT NULL
);

ALTER TABLE members ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('ernaehrung', 0, true, true, '{"id":"ernaehrung","key":"ernaehrung","type":"select","label":"Ernährung","options":[{"value":"meat","label":"Mit Fleisch"},{"value":"vegetarian","label":"Vegetarisch"},{"value":"vegan","label":"Vegan"}]}'::jsonb)
	ON CONFLICT (key) DO NOTHING;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('allergien', 1, true, true, '{"id":"allergien","key":"allergien","type":"textarea","label":"Allergien & Unverträglichkeiten","help":"z. B. Nüsse, Laktose, Wespenstich","maxLength":1000}'::jsonb)
	ON CONFLICT (key) DO NOTHING;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('medikamente', 2, true, true, '{"id":"medikamente","key":"medikamente","type":"textarea","label":"Medikamente (Name, Dosierung)","help":"Regelmäßig oder bei Bedarf einzunehmende Medikamente","maxLength":1000}'::jsonb)
	ON CONFLICT (key) DO NOTHING;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('gesundheit', 3, true, true, '{"id":"gesundheit","key":"gesundheit","type":"textarea","label":"Krankheiten / Hinweise zur Gesundheit","help":"Alles, was Leitende wissen sollten (z. B. Asthma, Epilepsie)","maxLength":1000}'::jsonb)
	ON CONFLICT (key) DO NOTHING;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('schwimmen', 4, true, true, '{"id":"schwimmen","key":"schwimmen","type":"select","label":"Schwimmfähigkeit","options":[{"value":"nichtschwimmer","label":"Nichtschwimmer*in"},{"value":"seepferdchen","label":"Seepferdchen"},{"value":"freischwimmer","label":"Freischwimmer*in"},{"value":"fahrtenschwimmer","label":"Fahrtenschwimmer*in"}]}'::jsonb)
	ON CONFLICT (key) DO NOTHING;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('zecken', 5, true, true, '{"id":"zecken","key":"zecken","type":"boolean","label":"Zecken dürfen entfernt werden"}'::jsonb)
	ON CONFLICT (key) DO NOTHING;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('tetanus', 6, true, true, '{"id":"tetanus","key":"tetanus","type":"boolean","label":"Tetanus-Impfschutz vorhanden"}'::jsonb)
	ON CONFLICT (key) DO NOTHING;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('krankenkasse', 7, true, true, '{"id":"krankenkasse","key":"krankenkasse","type":"text","label":"Krankenkasse","maxLength":100}'::jsonb)
	ON CONFLICT (key) DO NOTHING;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('notfallkontakt', 8, true, true, '{"id":"notfallkontakt","key":"notfallkontakt","type":"text","label":"Notfallkontakt (Name, Telefon)","help":"Erreichbar während der Aktion","maxLength":200}'::jsonb)
	ON CONFLICT (key) DO NOTHING;

INSERT INTO member_field_defs (key, position, active, preset, definition)
	VALUES ('juleica', 9, true, true, '{"id":"juleica","key":"juleica","type":"boolean","label":"Juleica vorhanden"}'::jsonb)
	ON CONFLICT (key) DO NOTHING;
