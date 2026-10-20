-- Ende der Gruppenstunde (HH:MM), z. B. 16:30-18:00 auf der Stammeswebsite
ALTER TABLE groups ADD COLUMN IF NOT EXISTS meeting_end_time text;
