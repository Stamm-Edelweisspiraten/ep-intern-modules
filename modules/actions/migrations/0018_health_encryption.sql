-- Gesundheitsdaten der Teilnehmenden verschlüsselt (core.crypto.forModule('actions')):
-- diet/allergies/notes enthalten künftig Chiffrate (enc:v1:…), die Prüfung der Ernährungswerte übernimmt
-- die Anwendung. Gesundheitsbezogene Formularantworten liegen verschlüsselt in health_answers (JSON).
-- Der Bestand wird von der Anwendung verschlüsselt (Job actions.encrypt-health, onEnable).
ALTER TABLE action_participants DROP CONSTRAINT IF EXISTS action_participants_diet_check;

ALTER TABLE action_participants ADD COLUMN IF NOT EXISTS health_answers text;
