-- Neuer Stand "jungpfadfinder" (zwischen Neuling-Jungpfadfinder und Knappe)
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_stage_check;
ALTER TABLE members ADD CONSTRAINT members_stage_check CHECK (stage IN (
	'neuling-woelfling', 'woelfling', 'neuling-jungpfadfinder', 'jungpfadfinder', 'knappe',
	'pfadfinder', 'spaeher', 'kreuzpfadfinder'
));
