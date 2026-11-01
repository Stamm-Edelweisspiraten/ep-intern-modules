import { describe, expect, it } from 'vitest';
import { buildReportBlocks, numberExpenses, summarize } from '$modules/actions/accounting';
import type { AccountingEntry, ReportInput, SummaryEntry } from '$modules/actions/schemas';
import type { PdfBlock } from '$lib/sdk/types';

type Table = Extract<PdfBlock, { type: 'table' }>;

const entry = (p: Partial<AccountingEntry>): AccountingEntry => ({
	id: 'x',
	type: 'expense',
	category: 'food',
	description: 'Einkauf',
	amountCents: 1000,
	entryDate: '2026-07-03',
	paidBy: 'club',
	payee: null,
	receipt: { name: 'a.pdf', contentType: 'application/pdf' },
	reimbursedAt: null,
	recipient: null,
	purpose: null,
	clubPaidAt: '2026-07-03T10:00:00.000Z',
	clubPaidVia: 'manual',
	createdAt: '2026-07-03T10:00:00.000Z',
	updatedAt: '',
	...p
});

const toSummary = (list: AccountingEntry[]): SummaryEntry[] =>
	list.map((e) => ({
		type: e.type,
		category: e.category,
		amountCents: e.amountCents,
		paidBy: e.paidBy,
		payeeId: e.payee?.id ?? null,
		hasReceipt: e.receipt !== null,
		reimbursed: e.reimbursedAt !== null
	}));

const make = (entries: AccountingEntry[], p: Partial<ReportInput> = {}): ReportInput => ({
	actionName: 'Sommerlager',
	location: 'Waldheim',
	startsOn: '2026-07-01',
	endsOn: '2026-07-10',
	closedAt: null,
	entries,
	summary: summarize(toSummary(entries), null),
	payees: [],
	...p
});

const tables = (b: PdfBlock[]): Table[] => b.filter((x): x is Table => x.type === 'table');
const byCaption = (b: PdfBlock[], left: string): Table | undefined =>
	tables(b).find((t) => t.caption?.left === left);

describe('numberExpenses', () => {
	const list = [
		entry({ id: 'c', category: 'lodging', entryDate: '2026-07-01' }),
		entry({ id: 'b', category: 'food', entryDate: '2026-07-05' }),
		entry({ id: 'a', category: 'food', entryDate: '2026-07-02' }),
		entry({ id: 'i', type: 'income', category: 'contributions' }),
		entry({ id: 'd', category: 'food', entryDate: '2026-07-02', createdAt: '2026-07-04T00:00:00Z' })
	];

	it('Kategorie, Datum, Erfassungszeit; Einnahmen ohne Nummer', () => {
		const m = numberExpenses(list);
		expect(m.get('a')).toBe(1);
		expect(m.get('d')).toBe(2);
		expect(m.get('b')).toBe(3);
		expect(m.get('c')).toBe(4);
		expect(m.has('i')).toBe(false);
	});

	it('ist stabil gegenüber der Eingabereihenfolge', () => {
		const a = numberExpenses(list);
		const b = numberExpenses([...list].reverse());
		expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
	});
});

describe('buildReportBlocks', () => {
	const entries = [
		entry({ id: 'e1', category: 'food', amountCents: 123450, description: 'Einkauf <b>' }),
		entry({ id: 'e2', category: 'lodging', amountCents: 50000, receipt: null }),
		entry({
			id: 'i1',
			type: 'income',
			category: 'contributions',
			amountCents: 60000,
			description: 'Beitrag',
			receipt: null
		}),
		entry({
			id: 'i2',
			type: 'income',
			category: 'subsidy',
			amountCents: 20000,
			receipt: null
		})
	];

	it('Titel, Zeitraum, Stand', () => {
		const b = buildReportBlocks(make(entries));
		expect(b[0]).toMatchObject({ type: 'paragraph' });
		const texts = b.filter((x) => x.type === 'paragraph').map((x) => (x as { text: string }).text);
		expect(texts[0]).toContain('01.07.2026 – 10.07.2026');
		expect(texts[0]).toContain('\nStatus: offen');
		const closed = buildReportBlocks(make(entries, { closedAt: '2026-08-01T10:00:00.000Z' }));
		expect(
			closed.filter((x) => x.type === 'paragraph').map((x) => (x as { text: string }).text)[0]
		).toContain('\nStand: 01.08.2026');
	});

	it('Einnahmen nach Gruppen, leere Gruppe entfällt, Summen stimmen', () => {
		const b = buildReportBlocks(make(entries));
		const contrib = byCaption(b, 'Teilnehmerbeiträge')!;
		expect(contrib.variant).toBe('grid');
		expect(contrib.caption?.right).toContain('600,00');
		expect(byCaption(b, 'Zuschüsse')!.caption?.right).toContain('200,00');
		expect(byCaption(b, 'Andere Einnahmen')).toBeUndefined();
		const total = tables(b).find((t) => t.totalRow?.[0] === 'Summe Einnahmen')!;
		expect(total.totalRow![1]).toContain('800,00');
	});

	it('Ausgaben je Kategorie mit Beleg-Nr. am Zeilenende', () => {
		const b = buildReportBlocks(make(entries));
		const food =
			byCaption(b, 'Verpflegung') ?? tables(b).find((t) => t.columns.includes('Beleg-Nr.'))!;
		expect(food.columns.at(-1)).toBe('Beleg-Nr.');
		expect(food.align?.at(-1)).toBe('right');
		expect(food.rows[0]!.at(-1)).toBe('1');
		const withMissing = tables(b).filter((t) => t.columns.includes('Beleg-Nr.'));
		expect(withMissing).toHaveLength(2);
		expect(withMissing[1]!.rows[0]!.at(-1)).toBe('2 (fehlt)');
		const total = tables(b).find((t) => t.totalRow?.[0] === 'Summe Ausgaben')!;
		expect(total.totalRow![1]).toContain('1.734,50');
	});

	it('Plus-/Minus-Beschriftung', () => {
		const label = (list: AccountingEntry[]) =>
			byCaption(buildReportBlocks(make(list)), 'Ergebnis der Abrechnung')!.totalRow![0];
		expect(label(entries)).toBe('Fehlbetrag');
		expect(label([entries[2]!])).toBe('Überschuss');
		expect(label([entries[2]!, entry({ amountCents: 60000, receipt: null })])).toBe('Ausgeglichen');
	});

	it('Erstattungen: IBAN wie übergeben, Verwendungszweck gekürzt, Summe', () => {
		const payees = [
			{
				name: 'Anna',
				openCents: 1000,
				reimbursedCents: 0,
				iban: 'DE89 •••• 3000',
				bic: 'COBADEFF'
			},
			{ name: 'Bob', openCents: 0, reimbursedCents: 500, iban: null, bic: null },
			{ name: 'Nix', openCents: 0, reimbursedCents: 0, iban: null, bic: null }
		];
		const b = buildReportBlocks(make(entries, { payees, actionName: 'X'.repeat(80) }));
		const t = byCaption(b, 'Erstattungen an Personen')!;
		expect(t.rows).toHaveLength(2);
		expect(t.columns).toEqual(['Name', 'Bankverbindung', 'Betrag', 'Status']);
		expect(t.rows[0]![1]).toBe('DE89 •••• 3000\nCOBADEFF');
		expect(t.rows[0]![3]).toBe('offen');
		expect(t.rows[1]![3]).toBe('ausgezahlt');
		expect(t.rows[1]![1]).toBe('–');
		expect(t.totalRow![0]).toEqual({ text: 'Summe', colspan: 2 });
		expect(t.totalRow![1]).toContain('15,00');
		const purpose = b
			.filter((x) => x.type === 'paragraph')
			.map((x) => (x as { text: string }).text)
			.find((x) => x.startsWith('Verwendungszweck der Überweisungen:'))!;
		expect(purpose.length).toBe('Verwendungszweck der Überweisungen: '.length + 60);
	});

	it('Abschluss: Reihenfolge, noHeader, Soll/Differenz nur mit Plan', () => {
		const b = buildReportBlocks(make(entries));
		const i = b.findIndex((x) => x.type === 'heading' && x.text === 'Abschluss');
		const after = b.slice(i).filter((x): x is Table => x.type === 'table');
		expect(after[0]!.caption?.left).toBe('Ergebnis der Abrechnung');
		expect(after[0]!.noHeader).toBe(true);
		expect(after[1]!.caption?.left).toBe('Einnahmen und Ausgaben je Kategorie');
		expect(after[1]!.columns).toEqual(['Kategorie', 'Art', 'Ist']);
		expect(after.at(-1)!.caption?.left).not.toBe('Plus-/Minus-Rechnung');
		const instr = byCaption(b, 'Buchungsanweisung für die Kasse')!;
		expect(instr.noHeader).toBe(true);
		expect(instr.totalRow![0]).toBe('Verbleibt in der Stammkasse');
		expect(byCaption(b, 'Rückzahlung an Teilnehmende')).toBeUndefined();
		const withPlan = buildReportBlocks(
			make(entries, {
				summary: summarize(toSummary(entries), {
					contributionsCents: 60000,
					subsidyCents: 20000,
					expenseByCategory: { food: 100000 },
					totalExpenseCents: 100000
				})
			})
		);
		expect(byCaption(withPlan, 'Einnahmen und Ausgaben je Kategorie')!.columns).toContain('Soll');
	});

	it('Rückzahlung: Block, Hinweis, Überschuss vor Rückzahlung, nicht in Nummerierung', () => {
		const refundEntry = entry({
			id: 'r1',
			category: 'refund',
			amountCents: 30000,
			description: 'Rückzahlung an Teilnehmende (3 × 100 €)',
			receipt: null
		});
		const all = [...entries, refundEntry];
		const input = make(all, {
			refund: {
				items: [
					{ name: 'Anna', amountCents: 10000 },
					{ name: 'Bert', amountCents: 10000 },
					{ name: 'Cleo', amountCents: 10000 }
				],
				totalCents: 30000,
				remainderCents: 150,
				bookedAt: '2026-07-20T10:00:00.000Z'
			}
		});
		expect(input.summary.missingReceipts).toBe(1); // nur e2, nicht die Rückzahlung
		expect(numberExpenses(all).has('r1')).toBe(false);
		const b = buildReportBlocks(input);
		const result = byCaption(b, 'Ergebnis der Abrechnung')!;
		// Einnahmen 800 - Ausgaben 1734,50 (ohne Rückzahlung) = Fehlbetrag
		expect(result.totalRow![0]).toBe('Fehlbetrag');
		const total = tables(b).find((t) => t.totalRow?.[0] === 'Summe Ausgaben')!;
		expect(total.totalRow![1]).toContain('1.734,50');
		const block = byCaption(b, 'Rückzahlung an Teilnehmende')!;
		expect(block.rows).toHaveLength(3);
		expect(block.caption?.right).toContain('300,00');
		const texts = b.filter((x) => x.type === 'paragraph').map((x) => (x as { text: string }).text);
		expect(texts.some((t) => t.startsWith('Hinweis: Die Rückzahlung erfolgt erst'))).toBe(true);
		expect(texts.some((t) => t.startsWith('Verbleibt in der Stammkasse: '))).toBe(true);
		expect(
			tables(b)
				.filter((t) => t.columns.includes('Beleg-Nr.'))
				.every((t) => !t.rows.some((r) => String(r[1]).startsWith('Rückzahlung')))
		).toBe(true);
		// Reihenfolge: Ergebnis < Kategorien < Rückzahlung < Buchungsanweisung
		const order = tables(b)
			.map((t) => t.caption?.left)
			.filter(Boolean);
		const idx = (n: string) => order.indexOf(n);
		expect(idx('Ergebnis der Abrechnung')).toBeLessThan(idx('Einnahmen und Ausgaben je Kategorie'));
		expect(idx('Rückzahlung an Teilnehmende')).toBeLessThan(idx('Buchungsanweisung für die Kasse'));
	});

	it('Hinweise: ohne Beleg, nicht abrufbar, Anlagenverzeichnis', () => {
		const b = buildReportBlocks(make(entries, { missingAttachments: 2, attachedEntryIds: [] }));
		const texts = b.filter((x) => x.type === 'paragraph').map((x) => (x as { text: string }).text);
		expect(texts).toContain('1 Ausgabe ohne Beleg.');
		expect(texts.some((t) => t.startsWith('2 Belege nicht abrufbar'))).toBe(true);
		const dir = byCaption(b, 'Anlagenverzeichnis')!;
		expect(dir.rows).toHaveLength(1);
		expect(dir.rows[0]![0]).toBe('1');
		expect(dir.rows[0]![1]).toContain('nicht angehängt');
	});

	it('Abschluss ist eine Zwischenüberschrift ohne harten Seitenumbruch', () => {
		const b = buildReportBlocks(make(entries));
		expect(b.some((x) => x.type === 'pageBreak')).toBe(false);
		expect(b.find((x) => x.type === 'heading' && x.text === 'Abschluss')).toMatchObject({
			level: 2
		});
	});

	it('leere Abrechnung bricht nicht', () => {
		const b = buildReportBlocks(make([]));
		expect(JSON.stringify(b)).toContain('Keine Einnahmen.');
		expect(JSON.stringify(b)).toContain('Keine Ausgaben.');
	});
});

describe('buildReportBlocks: Zwischenabrechnungen', () => {
	const za = { id: 'za1', number: 1 };
	const list = [
		entry({ id: 'a', description: 'Brot', interim: za }),
		entry({ id: 'b', description: 'Zelt', category: 'materials', interim: null }),
		entry({ id: 'i', type: 'income', category: 'misc', description: 'Spende', interim: za })
	];
	const refund = {
		items: [{ name: 'Kind', amountCents: 500 }],
		totalCents: 500,
		remainderCents: 0,
		bookedAt: '2026-07-20T00:00:00.000Z'
	};

	it('Zwischenbericht: Titel, Hinweis, Stichtag, keine Rückzahlung, keine ZA-Vermerke', () => {
		// 22:30 UTC = 00:30 in Berlin → Stichtag 06.07.2026
		const b = buildReportBlocks(
			make(list, { interim: { number: 1, takenAt: '2026-07-05T22:30:00.000Z' }, refund })
		);
		const text = JSON.stringify(b);
		expect(text).toContain('Zwischenabrechnung Nr. 1 – Stand 06.07.2026');
		expect(text).toContain(
			'Vorläufiger Stand zum 06.07.2026 – spätere Buchungen sind nicht enthalten.'
		);
		// gesamter Stand: alle Buchungen, ohne Vermerk
		expect(text).toContain('Brot');
		expect(text).toContain('Zelt');
		expect(text).not.toContain('(ZA');
		expect(text).not.toContain('Rückzahlung an Teilnehmende');
		expect(text).not.toContain('Stand bis einschließlich');
		expect(byCaption(b, 'Zwischenabrechnungen')).toBeUndefined();
		expect(b.find((x) => x.type === 'heading' && x.text === 'Ergebnis zum Stichtag')).toBeTruthy();
		expect(b.find((x) => x.type === 'heading' && x.text === 'Abschluss')).toBeUndefined();
		// Einnahmen 10 − Ausgaben 20 = −10
		const result = byCaption(b, 'Ergebnis zum Stichtag')!;
		expect(result.totalRow![0]).toBe('Fehlbetrag');
		const instr = byCaption(b, 'Buchungsanweisung für die Kasse')!;
		expect(instr.totalRow![0]).toBe('Saldo zum Stichtag');
		expect(instr.rows.some((r) => r[0] === 'Rückzahlung an Teilnehmende')).toBe(false);
	});

	it('Zwischenbericht: reines Datum als Stichtag', () => {
		const text = JSON.stringify(
			buildReportBlocks(make(list, { interim: { number: 2, takenAt: '2026-07-05' } }))
		);
		expect(text).toContain('Zwischenabrechnung Nr. 2 – Stand 05.07.2026');
	});

	it('Endbericht: keine ZA-Vermerke, keine ZA-Übersicht, Rückzahlung bleibt', () => {
		const b = buildReportBlocks(make(list, { refund }));
		const text = JSON.stringify(b);
		expect(text).toContain('Brot');
		expect(text).toContain('Spende');
		expect(text).not.toContain('(ZA');
		expect(text).not.toContain('Vorläufig');
		expect(byCaption(b, 'Zwischenabrechnungen')).toBeUndefined();
		expect(byCaption(b, 'Rückzahlung an Teilnehmende')).toBeDefined();
		expect(byCaption(b, 'Buchungsanweisung für die Kasse')!.totalRow![0]).toBe(
			'Verbleibt in der Stammkasse'
		);
	});
});
