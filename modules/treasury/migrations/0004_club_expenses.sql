-- Auszahlungen aus Ausgaben der Aktions-Abrechnung, die der Stamm ueberweist (`expense:<aktion>:<buchung>`)

ALTER TABLE payables DROP CONSTRAINT IF EXISTS payables_source_check;

ALTER TABLE payables ADD CONSTRAINT payables_source_check
	CHECK (source IN ('manual', 'reimbursement', 'refund', 'credit', 'expense'));
