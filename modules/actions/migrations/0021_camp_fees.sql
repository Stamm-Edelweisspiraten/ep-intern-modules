-- Modul "actions": Lagerbeitraege an uebergeordnete Ebenen (Gau, Landesmark, Bund)
-- als eigene Kategorien in Kalkulation und Abrechnung

ALTER TABLE calc_items DROP CONSTRAINT IF EXISTS calc_items_category_check;

ALTER TABLE calc_items ADD CONSTRAINT calc_items_category_check CHECK (category IN (
	'food', 'lodging', 'lodging_extra', 'materials', 'other', 'travel', 'program',
	'camp_fee_gau', 'camp_fee_landesmark', 'camp_fee_bund'
));

ALTER TABLE accounting_entries DROP CONSTRAINT IF EXISTS accounting_entries_category_check;

ALTER TABLE accounting_entries ADD CONSTRAINT accounting_entries_category_check CHECK (category IN (
	'food', 'lodging', 'lodging_extra', 'materials', 'other', 'travel', 'program',
	'camp_fee_gau', 'camp_fee_landesmark', 'camp_fee_bund',
	'contributions', 'subsidy', 'misc', 'refund'
));
