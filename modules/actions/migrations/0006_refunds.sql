-- Modul "actions": Rueckzahlung des Ueberschusses an Teilnehmende

ALTER TABLE accounting_entries DROP CONSTRAINT IF EXISTS accounting_entries_category_check;

ALTER TABLE accounting_entries ADD CONSTRAINT accounting_entries_category_check CHECK (category IN (
	'food', 'lodging', 'lodging_extra', 'materials', 'other', 'travel', 'program',
	'contributions', 'subsidy', 'misc', 'refund'
));

CREATE TABLE IF NOT EXISTS accounting_refunds (
	id text PRIMARY KEY,
	action_id text NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
	entry_id text,
	participant_id text,
	name text NOT NULL,
	amount_cents integer NOT NULL CHECK (amount_cents > 0),
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS accounting_refunds_action_idx ON accounting_refunds (action_id);

CREATE TABLE IF NOT EXISTS action_refund_booking (
	action_id text PRIMARY KEY REFERENCES actions (id) ON DELETE CASCADE,
	entry_id text NOT NULL,
	surplus_cents integer NOT NULL,
	per_head_cents integer NOT NULL,
	paying_count integer NOT NULL,
	remainder_cents integer NOT NULL,
	booked_at timestamptz NOT NULL DEFAULT now(),
	booked_by text
);
