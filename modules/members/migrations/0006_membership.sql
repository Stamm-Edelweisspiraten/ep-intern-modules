-- Modul "members" v6: Mitgliedschaft (Eintritt/Austritt) und Zweitmitglieder mit Beitragsebenen

ALTER TABLE members
	ADD COLUMN IF NOT EXISTS entry_date date,
	ADD COLUMN IF NOT EXISTS exit_date date,
	ADD COLUMN IF NOT EXISTS secondary_member boolean NOT NULL DEFAULT false,
	ADD COLUMN IF NOT EXISTS fee_levels text[] NOT NULL DEFAULT '{stamm,gau,landesmark,bund}';
