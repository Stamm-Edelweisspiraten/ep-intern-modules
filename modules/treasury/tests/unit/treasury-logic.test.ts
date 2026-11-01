import { describe, expect, it } from 'vitest';
import { csvCell, csvCents } from '$lib/sdk/csv';
import {
	addDays,
	computeDueOn,
	daysBetween,
	distribute,
	groupByAddress,
	invoiceNumbersIn,
	invoiceTotals,
	lineOpen,
	mailVars,
	matchMember,
	normalizeName,
	planPayables,
	planSync,
	reminderLevelDue,
	renderTemplate,
	suggestMatch,
	suggestPayers,
	type MatchLine,
	type MemberLite
} from '$modules/treasury/logic';
import {
	applyMapping,
	detectDelimiter,
	guessMapping,
	parseAmount,
	parseCsv,
	parseDate
} from '$modules/treasury/csv-import';

const member = (
	id: string,
	firstName: string,
	lastName: string,
	extra: Partial<MemberLite> = {}
): MemberLite => ({
	id,
	firstName,
	lastName,
	birthDate: '2015-01-01',
	emails: [],
	street: '',
	postalCode: '',
	city: '',
	...extra
});

describe('Datum', () => {
	it('rechnet Tage über Monats- und Jahresgrenzen', () => {
		expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
		expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
		expect(daysBetween('2026-03-01', '2026-02-27')).toBe(-3 + 1);
	});
});

describe('Rechnungsstatus', () => {
	it('offen, teilweise, bezahlt, ermäßigt', () => {
		expect(lineOpen({ amountCents: 18500, waivedCents: 0, paidCents: 0 })).toBe(18500);
		expect(lineOpen({ amountCents: 18500, waivedCents: 2000, paidCents: 16500 })).toBe(0);
		expect(lineOpen({ amountCents: 100, waivedCents: 0, paidCents: 500 })).toBe(0);
		expect(invoiceTotals([{ amountCents: 1000, waivedCents: 0, paidCents: 0 }], false).status).toBe(
			'open'
		);
		expect(invoiceTotals([{ amountCents: 1000, waivedCents: 0, paidCents: 1 }], false).status).toBe(
			'partial'
		);
		// Vollständiger Erlass gilt als bezahlt
		expect(
			invoiceTotals([{ amountCents: 1000, waivedCents: 1000, paidCents: 0 }], false)
		).toMatchObject({
			status: 'paid',
			totalCents: 0,
			openCents: 0
		});
	});
	it('Überzahlung und Storno werden Guthaben', () => {
		expect(
			invoiceTotals([{ amountCents: 1000, waivedCents: 0, paidCents: 1200 }], false).creditCents
		).toBe(200);
		expect(
			invoiceTotals([{ amountCents: 1000, waivedCents: 0, paidCents: 600 }], true)
		).toMatchObject({
			status: 'cancelled',
			openCents: 0,
			creditCents: 600
		});
	});
	it('NaN/Infinity zählen als 0', () => {
		expect(lineOpen({ amountCents: NaN, waivedCents: Infinity, paidCents: 0 })).toBe(0);
	});
});

describe('Verteilung', () => {
	const slots = [
		{ lineId: 'b', openCents: 18500, dueOn: '2026-07-06' },
		{ lineId: 'a', openCents: 9000, dueOn: '2026-06-01' },
		{ lineId: 'c', openCents: 0, dueOn: '2026-01-01' }
	];
	it('älteste Fälligkeit zuerst, Rest bleibt', () => {
		expect(distribute(10000, slots)).toEqual({
			allocations: [
				{ lineId: 'a', amountCents: 9000 },
				{ lineId: 'b', amountCents: 1000 }
			],
			restCents: 0
		});
		expect(distribute(30000, slots).restCents).toBe(30000 - 27500);
	});
	it('0 oder negativ verteilt nichts', () => {
		expect(distribute(0, slots).allocations).toEqual([]);
		expect(distribute(-5, slots)).toEqual({ allocations: [], restCents: 0 });
	});
});

describe('Fälligkeit und Erinnerungen', () => {
	it('14 Tage vor Beginn, aber mindestens 14 Tage nach heute', () => {
		const p = { today: '2026-06-01', daysBeforeStart: 14, minDays: 14 };
		expect(computeDueOn({ ...p, startsOn: '2026-08-01' })).toBe('2026-07-18');
		// Aktion liegt in der Vergangenheit: keine sofortige Überfälligkeit
		expect(computeDueOn({ ...p, startsOn: '2026-05-01' })).toBe('2026-06-15');
		expect(computeDueOn({ ...p, startsOn: '2026-08-01', override: '2026-07-01' })).toBe(
			'2026-07-01'
		);
	});
	const base = {
		dueOn: '2026-06-15',
		openCents: 100,
		cancelled: false,
		paused: false,
		sentLevel: 0,
		lastReminderOn: null as string | null,
		firstDays: 7,
		secondDays: 14
	};
	it('Stufe 1 genau ab Tag 7', () => {
		expect(reminderLevelDue({ ...base, today: '2026-06-21' })).toBeNull();
		expect(reminderLevelDue({ ...base, today: '2026-06-22' })).toBe(1);
	});
	it('Stufe 2 frühestens 14 Tage nach Stufe 1, danach keine', () => {
		const after = { ...base, sentLevel: 1, lastReminderOn: '2026-06-25' };
		expect(reminderLevelDue({ ...after, today: '2026-07-08' })).toBeNull();
		expect(reminderLevelDue({ ...after, today: '2026-07-09' })).toBe(2);
		expect(reminderLevelDue({ ...after, sentLevel: 2, today: '2026-12-01' })).toBeNull();
	});
	it('keine Erinnerung bei bezahlt, storniert oder pausiert', () => {
		const t = { ...base, today: '2026-08-01' };
		expect(reminderLevelDue({ ...t, openCents: 0 })).toBeNull();
		expect(reminderLevelDue({ ...t, cancelled: true })).toBeNull();
		expect(reminderLevelDue({ ...t, paused: true })).toBeNull();
	});
});

describe('Mitglieder zuordnen', () => {
	const members = [
		member('1', 'Lena', 'Müller', { birthDate: '2015-03-12' }),
		member('2', 'Lena', 'Müller', { birthDate: '2016-01-01' }),
		member('3', 'Jonas', 'Müller', { birthDate: '2013-08-02' })
	];
	it('Name + Geburtsdatum, Umlaute egal', () => {
		expect(
			matchMember({ memberId: null, name: 'Lena Mueller', birthDate: '2015-03-12' }, members)
		).toBe('1');
		expect(matchMember({ memberId: null, name: 'Jonas Müller', birthDate: null }, members)).toBe(
			'3'
		);
	});
	it('mehrdeutig ohne Geburtsdatum → keine Zuordnung', () => {
		expect(
			matchMember({ memberId: null, name: 'Lena Müller', birthDate: null }, members)
		).toBeNull();
	});
	it('vorhandene Verknüpfung gewinnt', () => {
		expect(matchMember({ memberId: '2', name: 'X', birthDate: null }, members)).toBe('2');
	});
	it('normalizeName', () => {
		expect(normalizeName('  Müller-Lüdenscheidt, Straße ')).toBe('mueller luedenscheidt strasse');
	});
});

describe('Abgleich mit Aktionen', () => {
	const source = {
		id: 'a1',
		name: 'Sommerlager',
		startsOn: '2026-08-01',
		feeCents: 18500,
		teamFeeCents: 0,
		participants: [
			{
				id: 'p1',
				name: 'Lena',
				role: 'participant' as const,
				birthDate: null,
				memberId: null,
				contactEmail: 'x@y.de'
			},
			{
				id: 'p2',
				name: 'Tim',
				role: 'team' as const,
				birthDate: null,
				memberId: null,
				contactEmail: null
			}
		]
	};
	const common = {
		excludedActionIds: new Set<string>(),
		dueOverrides: new Map<string, string>(),
		members: [],
		today: '2026-06-01',
		daysBeforeStart: 14,
		minDays: 14
	};
	it('legt nur zahlende Personen an (Team-Beitrag 0 → keine Rechnung)', () => {
		const plan = planSync({ ...common, sources: [source], existing: [] });
		expect(plan.create.map((c) => c.participantId)).toEqual(['p1']);
		expect(plan.create[0]).toMatchObject({
			amountCents: 18500,
			recipientEmail: 'x@y.de',
			dueOn: '2026-07-18'
		});
	});
	const existing = {
		lineId: 'l1',
		invoiceId: 'i1',
		sourceRef: 'action:a1:p1',
		amountCents: 18500,
		waivedCents: 0,
		description: 'Beitrag Sommerlager – Lena',
		memberId: null,
		cancelled: false,
		autoCancelled: false
	};
	it('ändert Betrag und begrenzt die Ermäßigung', () => {
		const plan = planSync({
			...common,
			sources: [{ ...source, feeCents: 10000 }],
			existing: [{ ...existing, waivedCents: 15000 }]
		});
		expect(plan.update).toEqual([
			expect.objectContaining({ lineId: 'l1', amountCents: 10000, waivedCents: 10000 })
		]);
	});
	it('storniert entfallene und reaktiviert nur automatisch stornierte', () => {
		expect(planSync({ ...common, sources: [], existing: [existing] }).cancel).toEqual([
			{ invoiceId: 'i1' }
		]);
		const auto = planSync({
			...common,
			sources: [source],
			existing: [{ ...existing, cancelled: true, autoCancelled: true }]
		});
		expect(auto.reactivate).toEqual([{ invoiceId: 'i1' }]);
		const manual = planSync({
			...common,
			sources: [source],
			existing: [{ ...existing, cancelled: true }]
		});
		expect(manual.reactivate).toEqual([]);
		expect(manual.create).toEqual([]);
	});
	it('ausgeschlossene Aktion wird storniert', () => {
		const plan = planSync({
			...common,
			excludedActionIds: new Set(['a1']),
			sources: [source],
			existing: [existing]
		});
		expect(plan.cancel).toEqual([{ invoiceId: 'i1' }]);
	});

	describe('vergangene Aktionen (eingefroren)', () => {
		const past = { ...source, isPast: true };
		const empty = { create: [], update: [], reactivate: [], cancel: [] };
		it('legt ohne bestehende Posten nichts an', () => {
			expect(planSync({ ...common, sources: [past], existing: [] })).toEqual(empty);
		});
		it('fasst offene und bezahlte Posten nicht an (kein Update, Storno, Reaktivieren)', () => {
			const paid = { ...existing, lineId: 'l2', invoiceId: 'i2', sourceRef: 'action:a1:p2' };
			const changed = { ...past, feeCents: 9999 };
			expect(planSync({ ...common, sources: [changed], existing: [existing, paid] })).toEqual(
				empty
			);
			// Teilnehmende*r entfällt, Betrag/Text geändert: weiterhin unverändert
			const gone = { ...past, participants: [] };
			expect(planSync({ ...common, sources: [gone], existing: [existing, paid] })).toEqual(empty);
			const cancelled = { ...existing, cancelled: true, autoCancelled: true };
			expect(planSync({ ...common, sources: [past], existing: [cancelled] })).toEqual(empty);
		});
		it('ohne Flag läuft alles normal weiter', () => {
			const plan = planSync({
				...common,
				sources: [{ ...source, isPast: false, feeCents: 10000 }],
				existing: [existing]
			});
			expect(plan.update).toHaveLength(1);
			expect(plan.create.map((c) => c.participantId)).toEqual([]);
			expect(
				planSync({ ...common, sources: [{ ...source, isPast: false }], existing: [] }).create
			).toHaveLength(1);
		});
		it('ausgeschlossene vergangene Aktion behält das Verhalten (Storno)', () => {
			const plan = planSync({
				...common,
				excludedActionIds: new Set(['a1']),
				sources: [past],
				existing: [existing]
			});
			expect(plan.cancel).toEqual([{ invoiceId: 'i1' }]);
		});
		it('Mischung: nur die vergangene Aktion ist eingefroren', () => {
			const other = {
				...source,
				id: 'a2',
				name: 'Herbstfahrt',
				participants: [source.participants[0]!]
			};
			const otherLine = {
				...existing,
				lineId: 'l9',
				invoiceId: 'i9',
				sourceRef: 'action:a2:p1',
				description: 'alt',
				amountCents: 1
			};
			const plan = planSync({
				...common,
				sources: [past, other],
				existing: [existing, otherLine]
			});
			expect(plan.cancel).toEqual([]);
			expect(plan.update).toEqual([expect.objectContaining({ lineId: 'l9', amountCents: 18500 })]);
			expect(plan.create).toEqual([]);
			const fresh = planSync({ ...common, sources: [past, other], existing: [] });
			expect(fresh.create.map((c) => c.actionId)).toEqual(['a2']);
		});
	});
});

describe('Zahler-Vorschläge', () => {
	it('gruppiert Geschwister über E-Mail und Anschrift', () => {
		const members = [
			member('1', 'Lena', 'Müller', { emails: ['fam@x.de'] }),
			member('2', 'Jonas', 'Müller', { emails: ['FAM@x.de'] }),
			member('3', 'Mia', 'Müller', { street: 'Lindenweg 4', postalCode: '28195' }),
			member('4', 'Paul', 'Schmidt', {
				street: 'Lindenweg 4',
				postalCode: '28195',
				emails: ['fam@x.de']
			}),
			member('5', 'Solo', 'Single', { emails: ['solo@x.de'] })
		];
		const s = suggestPayers(members, new Set());
		expect(s).toHaveLength(1);
		expect(s[0]!.memberIds).toEqual(['1', '2', '3', '4']);
		expect(s[0]!.name).toBe('Müller / Schmidt');
		expect(suggestPayers(members, new Set(['1', '2', '3']))).toEqual([]);
	});
});

describe('Zuordnungsvorschläge', () => {
	const line = (id: string, nr: string, name: string, open: number, group: string): MatchLine => ({
		lineId: id,
		invoiceId: `inv-${nr}`,
		invoiceNumber: nr,
		openCents: open,
		dueOn: '2026-07-01',
		names: [name],
		groupKey: group
	});
	const lines = [
		line('l1', 'R-2026-0001', 'Lena Müller', 18500, 'payer:m'),
		line('l2', 'R-2026-0002', 'Jonas Müller', 18500, 'payer:m'),
		line('l3', 'R-2026-0003', 'Paul Schmidt', 6000, 'last:schmidt')
	];
	it('Rechnungsnummer im Verwendungszweck (auch ohne Bindestrich)', () => {
		expect(invoiceNumbersIn('Zahlung R 2026-1 und R-2026-0003')).toEqual([
			'R-2026-0001',
			'R-2026-0003'
		]);
		const m = suggestMatch(
			{ amountCents: 6000, purpose: 'R-2026-0003', counterparty: null },
			lines
		);
		expect(m).toMatchObject({ confidence: 'high', invoiceNumbers: ['R-2026-0003'] });
	});
	it('Sammelzahlung für Geschwister über einen Namen', () => {
		const m = suggestMatch(
			{ amountCents: 37000, purpose: 'Lager Lena Mueller', counterparty: null },
			lines
		);
		expect(m?.confidence).toBe('high');
		expect(m?.allocations.map((a) => a.lineId).sort()).toEqual(['l1', 'l2']);
	});
	it('Aktion im Verwendungszweck grenzt Geschwister-Posten ein', () => {
		// Jonas hat zusätzlich eine offene Rechnung einer anderen Aktion
		const withTopics: MatchLine[] = [
			{ ...line('h1', 'R-2026-0010', 'Lena Müller', 3700, 'payer:m'), topic: 'Herbstfahrt 2026' },
			{ ...line('h2', 'R-2026-0011', 'Jonas Müller', 3700, 'payer:m'), topic: 'Herbstfahrt 2026' },
			{ ...line('h3', 'R-2026-0012', 'Mia Müller', 3700, 'payer:m'), topic: 'Herbstfahrt 2026' },
			{ ...line('k1', 'R-2026-0001', 'Jonas Müller', 18500, 'payer:m'), topic: 'Kopenhagen 2026' }
		];
		const m = suggestMatch(
			{ amountCents: 11100, purpose: 'Herbstfahrt Lena Jonas Mia Mueller', counterparty: null },
			withTopics
		);
		expect(m?.confidence).toBe('high');
		expect(m?.invoiceNumbers).toEqual(['R-2026-0010', 'R-2026-0011', 'R-2026-0012']);
	});
	it('Teilbetrag → mittlere Sicherheit, verteilt älteste zuerst', () => {
		const m = suggestMatch(
			{ amountCents: 10000, purpose: 'Jonas Müller Anzahlung', counterparty: null },
			lines
		);
		expect(m?.confidence).toBe('medium');
		expect(m?.allocations.reduce((s, a) => s + a.amountCents, 0)).toBe(10000);
	});
	it('nur Betrag → niedrig; nichts passend → null', () => {
		expect(
			suggestMatch({ amountCents: 6000, purpose: 'Danke', counterparty: 'X' }, lines)?.confidence
		).toBe('low');
		expect(
			suggestMatch({ amountCents: 1234, purpose: 'Spende', counterparty: null }, lines)
		).toBeNull();
		expect(
			suggestMatch({ amountCents: -100, purpose: 'R-2026-0001', counterparty: null }, lines)
		).toBeNull();
	});
});

describe('Mails', () => {
	it('ersetzt Platzhalter, lässt unbekannte stehen', () => {
		const vars = mailVars({
			invoices: [
				{
					number: 'R-2026-0001',
					recipientName: 'Lena',
					dueOn: '2026-07-06',
					lines: [{ description: 'Beitrag', cents: 18500 }]
				},
				{
					number: 'R-2026-0002',
					recipientName: 'Jonas',
					dueOn: '2026-07-01',
					lines: [{ description: 'Beitrag', cents: 18500 }]
				}
			],
			bank: { holder: 'Stamm', iban: 'DE02120300000000202051', bic: '', name: '' }
		});
		// formatEuro trennt Betrag und € mit geschütztem Leerzeichen
		const plain = (s: string) => s.replace(/\s/g, ' ');
		expect(plain(vars.summe!)).toBe('370,00 €');
		expect(vars.faellig).toBe('01.07.2026');
		expect(vars.kontodaten).toContain('DE02 1203 0000 0000 2020 51');
		expect(plain(renderTemplate('{name}: {summe} {unbekannt}', vars))).toBe(
			'Lena, Jonas: 370,00 € {unbekannt}'
		);
	});
	it('eine Mail je Adresse, ungültige Adressen fallen weg', () => {
		const g = groupByAddress([
			{ id: 1, addresses: ['A@x.de', 'b@x.de'] },
			{ id: 2, addresses: ['a@x.de', 'kaputt'] }
		]);
		expect([...g.keys()].sort()).toEqual(['a@x.de', 'b@x.de']);
		expect(g.get('a@x.de')!.map((i) => i.id)).toEqual([1, 2]);
	});
});

describe('CSV', () => {
	it('Export schützt vor Formeln, Beträge bleiben Zahlen (zentral in $lib/sdk/csv)', () => {
		expect(csvCell('=SUMME(A1)')).toBe("'=SUMME(A1)");
		expect(csvCell(csvCents(-1250))).toBe('-12,50');
		// Texte werden immer geschützt – auch wenn sie wie Zahlen aussehen (#34)
		expect(csvCell('-12,50')).toBe("'-12,50");
		expect(csvCell('a;b')).toBe('"a;b"');
	});
	it('Parser: Anführungszeichen, Umbrüche, BOM', () => {
		const rows = parseCsv('\ufeff"a";"b ""x"""\r\n"1";"zwei\nZeilen"\n', ';');
		expect(rows).toEqual([
			['a', 'b "x"'],
			['1', 'zwei\nZeilen']
		]);
		expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
	});
	it('Beträge und Daten', () => {
		expect(parseAmount('-1.234,56', ',')).toBe(-123456);
		expect(parseAmount('12,5', ',')).toBe(1250);
		expect(parseAmount('1,234.56', '.')).toBe(123456);
		expect(parseAmount('12,345', ',')).toBeNull();
		expect(parseAmount('abc', ',')).toBeNull();
		expect(parseDate('10.06.26', 'DD.MM.YY')).toBe('2026-06-10');
		expect(parseDate('31.02.2026', 'DD.MM.YYYY')).toBeNull();
		expect(parseDate('2026-06-10', 'YYYY-MM-DD')).toBe('2026-06-10');
	});
	it('erkennt Spalten und vergibt fortlaufende Schlüssel für gleiche Zeilen', () => {
		const headers = [
			'Buchungstag',
			'Verwendungszweck',
			'Beguenstigter/Zahlungspflichtiger',
			'Betrag'
		];
		const m = guessMapping(headers, ['10.06.26', 'x', 'y', '5,00'], ';')!;
		expect(m).toMatchObject({
			date: 'Buchungstag',
			amount: 'Betrag',
			dateFormat: 'DD.MM.YY',
			decimal: ','
		});
		const rows = applyMapping(
			[
				headers,
				['10.06.26', 'Spende', 'Max', '5,00'],
				['10.06.26', 'Spende', 'Max', '5,00'],
				['x', '', '', '1']
			],
			m
		);
		expect(rows[0]!.key).not.toBe(rows[1]!.key);
		expect(rows[2]!.error).toBe('Datum nicht lesbar');
		expect(guessMapping(['Foo', 'Bar'], undefined, ';')).toBeNull();
	});
});

describe('IBAN (Kasse)', () => {
	it('prüft, normalisiert und maskiert', async () => {
		const { isValidIban, normalizeIban, maskIban, formatIban } =
			await import('$modules/treasury/iban');
		expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
		expect(isValidIban('DE89370400440532013001')).toBe(false);
		expect(isValidIban('DE8937040044053201300')).toBe(false);
		expect(normalizeIban(' de89-3704 0044 ')).toBe('DE8937040044');
		expect(maskIban('3000')).toBe('•••• 3000');
		expect(maskIban(null)).toBeNull();
		expect(formatIban('DE89370400440532013000')).toBe('DE89 3704 0044 0532 0130 00');
	});
});

describe('Auszahlungen planen', () => {
	const d = (ref: string, amount: number) => ({
		sourceRef: ref,
		source: 'reimbursement' as const,
		actionId: 'a',
		recipientName: 'Anna',
		description: 'Auslagen',
		amountCents: amount,
		payerId: null,
		memberId: null,
		ibanLast4: null,
		bic: null
	});
	const e = (ref: string, amount: number, paid: number, extra = {}) => ({
		id: `id-${ref}`,
		sourceRef: ref,
		amountCents: amount,
		paidCents: paid,
		description: 'Auslagen',
		recipientName: 'Anna',
		payerId: null,
		cancelled: false,
		autoCancelled: false,
		...extra
	});
	it('legt neue an, ignoriert Betrag 0', () => {
		const p = planPayables([d('r1', 500), d('r2', 0)], []);
		expect(p.create.map((x) => x.sourceRef)).toEqual(['r1']);
	});
	it('storniert entfallene nur ohne Zahlung', () => {
		expect(planPayables([], [e('r1', 500, 0)]).cancel).toEqual(['id-r1']);
		expect(planPayables([], [e('r1', 500, 500)]).cancel).toEqual([]);
	});
	it('Betrag fällt nie unter das Gezahlte, manuell storniert bleibt', () => {
		const p = planPayables([d('r1', 300)], [e('r1', 500, 400)]);
		expect(p.update[0]).toMatchObject({ id: 'id-r1', amountCents: 400 });
		const manual = planPayables([d('r1', 500)], [e('r1', 500, 0, { cancelled: true })]);
		expect(manual).toMatchObject({ reactivate: [], update: [], create: [] });
		const auto = planPayables(
			[d('r1', 500)],
			[e('r1', 500, 0, { cancelled: true, autoCancelled: true })]
		);
		expect(auto.reactivate).toEqual(['id-r1']);
	});
});

describe('Vorschlag über die IBAN des Zahlers', () => {
	const lines: MatchLine[] = [
		{
			lineId: 'a',
			invoiceId: 'i1',
			invoiceNumber: 'R-2026-0001',
			openCents: 3700,
			dueOn: '2026-07-01',
			names: ['Lena Müller'],
			groupKey: 'payer:p1',
			topic: 'Herbstfahrt 2026'
		},
		{
			lineId: 'b',
			invoiceId: 'i2',
			invoiceNumber: 'R-2026-0002',
			openCents: 3700,
			dueOn: '2026-07-01',
			names: ['Mia Müller'],
			groupKey: 'payer:p1',
			topic: 'Herbstfahrt 2026'
		},
		{
			lineId: 'c',
			invoiceId: 'i3',
			invoiceNumber: 'R-2026-0003',
			openCents: 26600,
			dueOn: '2026-06-01',
			names: ['Jonas Müller'],
			groupKey: 'payer:p1',
			topic: 'Kopenhagen 2026'
		}
	];
	it('Familie über IBAN, Thema grenzt ein', () => {
		const m = suggestMatch(
			{ amountCents: 7400, purpose: 'Herbstfahrt', counterparty: 'X', payerId: 'p1' },
			lines
		);
		expect(m).toMatchObject({ confidence: 'high', invoiceNumbers: ['R-2026-0001', 'R-2026-0002'] });
		const single = suggestMatch(
			{ amountCents: 26600, purpose: '', counterparty: null, payerId: 'p1' },
			lines
		);
		expect(single?.invoiceNumbers).toEqual(['R-2026-0003']);
		const none = suggestMatch(
			{ amountCents: 7400, purpose: 'Herbstfahrt', counterparty: 'X', payerId: 'p9' },
			lines
		);
		expect(none?.confidence).not.toBe('high');
	});
	it('IBAN-Spalte wird erkannt', () => {
		const m = guessMapping(
			['Buchungstag', 'Betrag', 'Kontonummer/IBAN'],
			['01.01.26', '1,00', 'DE'],
			';'
		)!;
		expect(m.iban).toBe('Kontonummer/IBAN');
	});
});
