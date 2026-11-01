import { describe, expect, it } from 'vitest';
import {
	MAX_PAYMENT_CENTS,
	distributeOverLines,
	foldText,
	linesOfGroup,
	paymentCandidates,
	pressKey
} from '$modules/treasury/pages/payment-capture';
import type { InvoiceSummary, OpenItemsGroup, OpenLine } from '$modules/treasury/schemas';

const inv = (id: string, number: string, people: string[] = []): InvoiceSummary =>
	({ id, number, people, recipientName: people[0] ?? 'Unbekannt' }) as InvoiceSummary;
const group = (key: string, label: string, openCents: number, invoices: InvoiceSummary[]) =>
	({ key, label, openCents, invoices }) as OpenItemsGroup;
const line = (
	lineId: string,
	invoiceId: string,
	openCents: number,
	dueOn: string,
	n = 'R-2026-0001'
) => ({ lineId, invoiceId, openCents, dueOn, invoiceNumber: n }) as OpenLine;

describe('pressKey (Tastenfeld)', () => {
	it('tippt Cent von rechts ein: 1 → 4 → 6 → 0 → 0 = 146,00 €', () => {
		let c = 0;
		for (const k of ['1', '4', '6', '0', '0']) c = pressKey(c, k);
		expect(c).toBe(14600);
	});
	it('„00“ hängt zwei Nullen an, „back“ löscht die letzte Ziffer', () => {
		expect(pressKey(12, '00')).toBe(1200);
		expect(pressKey(1234, 'back')).toBe(123);
		expect(pressKey(0, 'back')).toBe(0);
	});
	it('bleibt beim Maximum stehen und ignoriert Fremdes', () => {
		expect(pressKey(MAX_PAYMENT_CENTS, '1')).toBe(MAX_PAYMENT_CENTS);
		expect(pressKey(MAX_PAYMENT_CENTS / 10, '0')).toBe(MAX_PAYMENT_CENTS);
		expect(pressKey(MAX_PAYMENT_CENTS / 10 + 1, '0')).toBe(MAX_PAYMENT_CENTS / 10 + 1);
		expect(pressKey(5, 'x')).toBe(5);
	});
});

describe('foldText', () => {
	it('ignoriert Groß-/Kleinschreibung, Umlaute und ß', () => {
		expect(foldText('Müller')).toBe(foldText('MULLER'));
		expect(foldText('Strauß')).toBe('strauss');
	});
});

describe('paymentCandidates', () => {
	const groups = [
		group('a', 'Zimmermann', 5000, [inv('i1', 'R-2026-0003', ['Zoe Zimmermann'])]),
		group('b', 'Müller', 14600, [inv('i2', 'R-2026-0001', ['Mia Müller', 'Max Müller'])]),
		group('c', 'Becker', 14600, [inv('i3', 'R-2026-0002', ['Ben Becker'])])
	];
	it('passender Betrag zuerst, dann alphabetisch', () => {
		expect(paymentCandidates(groups, '', 14600).map((g) => g.key)).toEqual(['c', 'b', 'a']);
		expect(paymentCandidates(groups, '', 0).map((g) => g.key)).toEqual(['c', 'b', 'a']);
		expect(paymentCandidates(groups, '', 5000).map((g) => g.key)).toEqual(['a', 'c', 'b']);
	});
	it('sucht in Name, Personen und Rechnungsnummer (ohne Umlaute)', () => {
		expect(paymentCandidates(groups, 'mueller', 0)).toEqual([]);
		expect(paymentCandidates(groups, 'muller', 0).map((g) => g.key)).toEqual(['b']);
		expect(paymentCandidates(groups, 'max', 0).map((g) => g.key)).toEqual(['b']);
		expect(paymentCandidates(groups, 'R-2026-0003', 0).map((g) => g.key)).toEqual(['a']);
	});
	it('verändert die Eingabe nicht', () => {
		const copy = groups.map((g) => g.key);
		paymentCandidates(groups, '', 14600);
		expect(groups.map((g) => g.key)).toEqual(copy);
	});
});

describe('linesOfGroup / distributeOverLines', () => {
	const g = group('b', 'Müller', 0, [inv('i1', 'R-2026-0001'), inv('i2', 'R-2026-0002')]);
	const lines = [
		line('l3', 'other', 1000, '2026-01-01'),
		line('l2', 'i2', 8000, '2026-11-01', 'R-2026-0002'),
		line('l1', 'i1', 6600, '2026-10-01', 'R-2026-0001')
	];
	it('nur Posten der Gruppe, älteste Fälligkeit zuerst', () => {
		expect(linesOfGroup(g, lines).map((l) => l.lineId)).toEqual(['l1', 'l2']);
		expect(linesOfGroup(null, lines)).toEqual([]);
	});
	it('bevorzugte Rechnung (Start aus der Rechnung) kommt zuerst', () => {
		expect(linesOfGroup(g, lines, 'i2').map((l) => l.lineId)).toEqual(['l2', 'l1']);
		// 100,00 € aus Rechnung R-2026-0002: erst deren 80,00 €, dann 20,00 € auf die ältere
		expect(distributeOverLines(10000, linesOfGroup(g, lines, 'i2'))).toEqual({
			l2: 8000,
			l1: 2000
		});
	});
	it('verteilt der Reihe nach, je Posten höchstens offen', () => {
		const own = linesOfGroup(g, lines);
		// 100,00 € = 66,00 € auf l1 + 34,00 € auf l2
		expect(distributeOverLines(10000, own)).toEqual({ l1: 6600, l2: 3400 });
		// genau alles: 146,00 €
		expect(distributeOverLines(14600, own)).toEqual({ l1: 6600, l2: 8000 });
		// mehr als offen: Rest bleibt übrig
		expect(distributeOverLines(20000, own)).toEqual({ l1: 6600, l2: 8000 });
		expect(distributeOverLines(50, own)).toEqual({ l1: 50 });
	});
	it('0, negativ oder NaN verteilt nichts', () => {
		const own = linesOfGroup(g, lines);
		expect(distributeOverLines(0, own)).toEqual({});
		expect(distributeOverLines(-5, own)).toEqual({});
		expect(distributeOverLines(Number.NaN, own)).toEqual({});
	});
});
