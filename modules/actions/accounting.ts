import type { PdfBlock } from '$lib/sdk/types';
import { todayBerlin } from '$lib/sdk/dates';
import { csvCents, csvDocument } from '$lib/sdk/csv';
import { formatEuro } from '$lib/components/layout/money';
import { appliedAutoIncome } from './auto-income';
import { donationTotals } from './refund';
import {
	ACCOUNTING_CATEGORY_LABELS,
	CALC_CATEGORIES,
	INCOME_CATEGORIES,
	PAID_BY_LABELS,
	isIncomeCategory
} from './schemas';
import type {
	AccountingCategory,
	AccountingEntry,
	AccountingCategorySummary,
	AccountingPlan,
	AccountingSummary,
	AutoIncome,
	PayoutRow,
	ReportInput,
	SummaryEntry
} from './schemas';

/**
 * Reine Abrechnungslogik (Server und UI). Alle Beträge Integer-Cent, nie NaN.
 */

/** Defensiv: nur endliche Zahlen, auf Integer gerundet; sonst 0. */
function cents(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function optCents(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/** Buchung (DTO) → Eintrag für `summarize`/`payeeTotals`. */
export function toSummaryEntry(e: AccountingEntry): SummaryEntry {
	return {
		type: e.type,
		category: e.category,
		amountCents: e.amountCents,
		paidBy: e.paidBy,
		payeeId: e.payee?.id ?? null,
		hasReceipt: e.receipt !== null,
		reimbursed: e.reimbursedAt !== null,
		clubOpen: e.type === 'expense' && e.paidBy === 'club' && e.clubPaidAt === null
	};
}

/** Summen, Saldo, Soll/Ist je Kategorie, fehlende Belege, offene Auslagen. */
export function summarize(
	entries: SummaryEntry[],
	plan: AccountingPlan | null,
	autoIncome: AutoIncome | null = null
): AccountingSummary {
	let incomeCents = 0;
	let expenseCents = 0;
	let missingReceipts = 0;
	let openReimbursementCents = 0;
	const openClubPayments = { count: 0, cents: 0 };
	const actual = new Map<string, number>();

	for (const e of entries ?? []) {
		const amount = cents(e.amountCents);
		actual.set(e.category, (actual.get(e.category) ?? 0) + amount);
		if (e.type === 'income') {
			incomeCents += amount;
		} else {
			expenseCents += amount;
			if (!e.hasReceipt && e.category !== 'refund') missingReceipts += 1;
			if (e.paidBy === 'person' && !e.reimbursed) openReimbursementCents += amount;
			if (e.paidBy === 'club' && e.clubOpen && e.category !== 'refund') {
				openClubPayments.count += 1;
				openClubPayments.cents += amount;
			}
		}
	}

	// Automatische Einnahmen zählen, solange keine manuelle Buchung der Kategorie existiert.
	const auto = appliedAutoIncome(autoIncome);
	if (auto.contributionsCents > 0 || auto.subsidyCents > 0) {
		incomeCents += auto.contributionsCents + auto.subsidyCents;
		actual.set('contributions', (actual.get('contributions') ?? 0) + auto.contributionsCents);
		actual.set('subsidy', (actual.get('subsidy') ?? 0) + auto.subsidyCents);
	}

	const planContrib = optCents(plan?.contributionsCents);
	const planSubsidy = optCents(plan?.subsidyCents);
	const plannedIncomeCents =
		plan && (planContrib !== null || planSubsidy !== null)
			? (planContrib ?? 0) + (planSubsidy ?? 0)
			: null;
	const plannedExpenseCents = optCents(plan?.totalExpenseCents);

	const byCategory: AccountingCategorySummary[] = [];
	const order: AccountingCategory[] = [...INCOME_CATEGORIES, ...CALC_CATEGORIES, 'refund'];
	for (const category of order) {
		let planned: number | null;
		if (category === 'contributions') planned = planContrib;
		else if (category === 'subsidy') planned = planSubsidy;
		else if (category === 'misc' || category === 'refund') planned = null;
		else planned = optCents(plan?.expenseByCategory?.[category]);
		const actualCents = actual.get(category) ?? 0;
		if (actualCents > 0 || (planned ?? 0) > 0) {
			byCategory.push({
				category,
				type: isIncomeCategory(category) ? 'income' : 'expense',
				plannedCents: planned,
				actualCents
			});
		}
	}

	return {
		incomeCents,
		expenseCents,
		balanceCents: incomeCents - expenseCents,
		plannedIncomeCents,
		plannedExpenseCents,
		byCategory,
		missingReceipts,
		openReimbursementCents,
		openClubPayments
	};
}

export interface PayeeTotals {
	openCents: number;
	reimbursedCents: number;
	openEntries: number;
}

/** Auslagen je Empfänger (nur `paidBy = person`); Schlüssel = payeeId. */
export function payeeTotals(entries: SummaryEntry[]): Map<string, PayeeTotals> {
	const map = new Map<string, PayeeTotals>();
	for (const e of entries ?? []) {
		if (e.type !== 'expense' || e.paidBy !== 'person' || !e.payeeId) continue;
		let t = map.get(e.payeeId);
		if (!t) {
			t = { openCents: 0, reimbursedCents: 0, openEntries: 0 };
			map.set(e.payeeId, t);
		}
		const amount = cents(e.amountCents);
		if (e.reimbursed) t.reimbursedCents += amount;
		else {
			t.openCents += amount;
			t.openEntries += 1;
		}
	}
	return map;
}

/** CSV der Auszahlungsliste (zentral `$lib/sdk/csv`: UTF-8-BOM, `;`, CRLF, Formel-Schutz; Betrag „1234,50“). */
export function toPayoutCsv(rows: PayoutRow[]): string {
	return csvDocument(
		['Name', 'IBAN', 'BIC', 'Betrag', 'Verwendungszweck', 'Anzahl Belege'],
		(rows ?? []).map((r) => [
			r.name,
			r.iban,
			r.bic ?? '',
			csvCents(Math.max(0, cents(r.amountCents))),
			r.purpose,
			Math.max(0, cents(r.entryCount))
		])
	);
}

const money = (value: number | null): string => (value === null ? '–' : formatEuro(cents(value)));

function germanDate(iso: string | null | undefined): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
	return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso ?? '');
}

/** Stichtag (ISO-Zeitstempel) als TT.MM.JJJJ in Europe/Berlin; reines Datum unverändert. */
function stichtag(iso: string): string {
	if (!iso.includes('T')) return germanDate(iso);
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return germanDate(iso);
	return germanDate(todayBerlin(d));
}

const categoryLabel = (c: string): string =>
	(ACCOUNTING_CATEGORY_LABELS as Record<string, string>)[c] ?? c;

/**
 * Fortlaufende Belegnummern der Ausgaben: nach Kategorie-Reihenfolge, Datum, Erfassungszeit, id.
 * Einnahmen erhalten keine Nummer. Schlüssel = Buchungs-id, Wert = 1..n.
 */
export function numberExpenses(
	entries: Pick<AccountingEntry, 'id' | 'type' | 'category' | 'entryDate' | 'createdAt'>[]
): Map<string, number> {
	const rank = (c: string): number => {
		const i = (CALC_CATEGORIES as readonly string[]).indexOf(c);
		return i < 0 ? CALC_CATEGORIES.length : i;
	};
	const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
	const list = (entries ?? [])
		.filter((e) => e.type === 'expense' && e.category !== 'refund')
		.sort(
			(a, b) =>
				rank(a.category) - rank(b.category) ||
				cmp(a.entryDate, b.entryDate) ||
				cmp(a.createdAt ?? '', b.createdAt ?? '') ||
				cmp(a.id, b.id)
		);
	const map = new Map<string, number>();
	list.forEach((e, i) => map.set(e.id, i + 1));
	return map;
}

/** Hinweis im Bericht einer Zwischenabrechnung (Stichtag als TT.MM.JJJJ). */
export const interimNotice = (date: string): string =>
	`Vorläufiger Stand zum ${date} – spätere Buchungen sind nicht enthalten.`;

const withDonation = (i: { name: string; amountCents: number; donatedCents?: number }) => ({
	name: i.name,
	amountCents: cents(i.amountCents),
	donatedCents: Math.min(cents(i.donatedCents ?? 0), cents(i.amountCents))
});

/** Inhaltsblöcke des PDF-Berichts (Gitter-Tabellen, Beleg-Nummern, Abschlussseite). */
export function buildReportBlocks(input: ReportInput): PdfBlock[] {
	const s = input.summary;
	const entries = input.entries ?? [];
	const numbering = numberExpenses(entries);
	const blocks: PdfBlock[] = [];
	const sum = (list: AccountingEntry[]): number =>
		list.reduce((acc, e) => acc + cents(e.amountCents), 0);
	const refundBookedCents = sum(entries.filter((e) => e.category === 'refund'));
	const expenseExRefund = Math.max(0, cents(s.expenseCents) - refundBookedCents);
	const payerOf = (e: AccountingEntry): string => {
		if (e.paidBy === 'person' && e.payee) return e.payee.name;
		// Offene Stamm-Ausgabe: Überweisung durch die Kasse steht noch aus
		if (e.type === 'expense' && e.category !== 'refund' && e.clubPaidAt === null) {
			return `${PAID_BY_LABELS.club} (offen)`;
		}
		return PAID_BY_LABELS[e.paidBy];
	};

	const period = input.endsOn
		? `${germanDate(input.startsOn)} – ${germanDate(input.endsOn)}`
		: germanDate(input.startsOn);
	const periodLine = input.location
		? `Zeitraum: ${period}, Ort: ${input.location}`
		: `Zeitraum: ${period}`;
	const interim = input.interim ?? null;
	if (interim) {
		blocks.push({
			type: 'paragraph',
			text: `${periodLine}\nZwischenabrechnung Nr. ${interim.number} – Stand ${stichtag(interim.takenAt)}`
		});
		blocks.push({ type: 'paragraph', text: interimNotice(stichtag(interim.takenAt)) });
	} else {
		blocks.push({
			type: 'paragraph',
			text: `${periodLine}\n${input.closedAt ? `Stand: ${germanDate(input.closedAt)}` : 'Status: offen'}`
		});
	}
	// --- Einnahmen
	blocks.push({ type: 'heading', level: 2, text: 'Einnahmen' });
	const incomes = entries.filter((e) => e.type === 'income');
	const planned = new Map<string, number | null>(
		s.byCategory.map((c) => [c.category as string, c.plannedCents])
	);
	const incomeGroups: [string, string][] = [
		['contributions', 'Teilnehmerbeiträge'],
		['subsidy', 'Zuschüsse'],
		['misc', 'Andere Einnahmen']
	];
	const autoApplied = appliedAutoIncome(input.autoIncome);
	const autoRowFor = (cat: string): { label: string; cents: number } | null => {
		const a = input.autoIncome;
		if (!a) return null;
		if (cat === 'contributions' && a.contributions && autoApplied.contributionsCents > 0) {
			const c = a.contributions;
			const parts = [];
			if (c.payingCount > 0) parts.push(`${c.payingCount} × ${money(c.feeCents)}`);
			if (c.teamCount > 0 && c.teamFeeCents > 0) {
				parts.push(`${c.teamCount} × ${money(c.teamFeeCents)}`);
			}
			return {
				label: `Automatisch aus Anmeldungen (${parts.join(' + ')})`,
				cents: c.cents
			};
		}
		if (cat === 'subsidy' && a.subsidy && autoApplied.subsidyCents > 0) {
			const n = a.subsidy.eligibleCount;
			return {
				label: `Zuschuss laut Kalkulation (${n} ${n === 1 ? 'berechtigte Person' : 'berechtigte Personen'})`,
				cents: a.subsidy.cents
			};
		}
		return null;
	};
	let shownIncomeGroups = 0;
	for (const [cat, title] of incomeGroups) {
		const list = incomes
			.filter((e) => e.category === cat)
			.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));
		const autoRow = autoRowFor(cat);
		if (list.length === 0 && !autoRow && (planned.get(cat) ?? 0) <= 0) continue;
		shownIncomeGroups += 1;
		const rows = list.map((e) => [germanDate(e.entryDate), e.description, money(e.amountCents)]);
		if (autoRow) rows.unshift(['–', autoRow.label, money(autoRow.cents)]);
		blocks.push({
			type: 'table',
			variant: 'grid',
			caption: { left: title, right: money(sum(list) + (autoRow?.cents ?? 0)) },
			columns: ['Datum', 'Bezeichnung', 'Betrag'],
			align: ['left', 'left', 'right'],
			widths: [2, 7, 2],
			rows: rows.length === 0 ? [['–', 'Keine Buchungen', money(0)]] : rows
		});
	}
	if (shownIncomeGroups === 0) blocks.push({ type: 'paragraph', text: 'Keine Einnahmen.' });
	blocks.push({
		type: 'table',
		variant: 'grid',
		columns: ['Bezeichnung', 'Betrag'],
		align: ['left', 'right'],
		widths: [9, 2],
		rows: [],
		totalRow: ['Summe Einnahmen', money(s.incomeCents)]
	});

	// --- Ausgaben
	blocks.push({ type: 'heading', level: 2, text: 'Ausgaben' });
	const expenses = entries
		.filter((e) => e.type === 'expense' && e.category !== 'refund')
		.sort((a, b) => (numbering.get(a.id) ?? 0) - (numbering.get(b.id) ?? 0));
	if (expenses.length === 0) blocks.push({ type: 'paragraph', text: 'Keine Ausgaben.' });
	for (const cat of CALC_CATEGORIES) {
		const list = expenses.filter((e) => e.category === cat);
		if (list.length === 0) continue;
		blocks.push({
			type: 'table',
			variant: 'grid',
			caption: { left: categoryLabel(cat), right: money(sum(list)) },
			columns: ['Datum', 'Bezeichnung', 'Bezahlt von', 'Betrag', 'Beleg-Nr.'],
			align: ['left', 'left', 'left', 'right', 'right'],
			widths: [2, 5, 3, 2, 2],
			rows: list.map((e) => [
				germanDate(e.entryDate),
				e.description,
				payerOf(e),
				money(e.amountCents),
				e.receipt ? String(numbering.get(e.id)) : `${numbering.get(e.id)} (fehlt)`
			])
		});
	}
	blocks.push({
		type: 'table',
		variant: 'grid',
		columns: ['Bezeichnung', 'Betrag'],
		align: ['left', 'right'],
		widths: [9, 2],
		rows: [],
		totalRow: ['Summe Ausgaben', money(expenseExRefund)]
	});

	// --- Abschlussseite
	blocks.push({
		type: 'heading',
		level: 2,
		text: interim ? 'Ergebnis zum Stichtag' : 'Abschluss'
	});

	// Überschuss VOR einer Rückzahlungsbuchung
	const result = cents(s.incomeCents) - expenseExRefund;
	const resultLabel = result > 0 ? 'Überschuss' : result < 0 ? 'Fehlbetrag' : 'Ausgeglichen';
	blocks.push({
		type: 'table',
		variant: 'grid',
		caption: {
			left: interim ? 'Ergebnis zum Stichtag' : 'Ergebnis der Abrechnung',
			right: money(result)
		},
		noHeader: true,
		columns: ['Position', 'Betrag'],
		align: ['left', 'right'],
		widths: [9, 2],
		rows: [
			['Einnahmen', money(s.incomeCents)],
			['Ausgaben', `− ${money(expenseExRefund)}`]
		],
		totalRow: [resultLabel, money(result)]
	});

	const categories = s.byCategory.filter((c) => c.category !== 'refund');
	if (categories.length > 0) {
		const withPlan = categories.some((c) => c.plannedCents !== null);
		blocks.push({
			type: 'table',
			variant: 'grid',
			caption: { left: 'Einnahmen und Ausgaben je Kategorie' },
			columns: withPlan
				? ['Kategorie', 'Art', 'Soll', 'Ist', 'Differenz']
				: ['Kategorie', 'Art', 'Ist'],
			align: withPlan ? ['left', 'left', 'right', 'right', 'right'] : ['left', 'left', 'right'],
			widths: withPlan ? [4, 2, 2, 2, 2] : [6, 3, 2],
			rows: categories.map((c) => {
				const base = [categoryLabel(c.category), c.type === 'income' ? 'Einnahme' : 'Ausgabe'];
				return withPlan
					? [
							...base,
							money(c.plannedCents),
							money(c.actualCents),
							c.plannedCents === null ? '–' : money(c.actualCents - c.plannedCents)
						]
					: [...base, money(c.actualCents)];
			})
		});
	}

	const payees = (input.payees ?? []).filter(
		(p) => cents(p.openCents) + cents(p.reimbursedCents) > 0
	);
	const payeesTotal = payees.reduce((a, p) => a + cents(p.openCents) + cents(p.reimbursedCents), 0);
	const payeesPaid = payees.reduce((a, p) => a + cents(p.reimbursedCents), 0);
	const payeesOpen = payees.reduce((a, p) => a + cents(p.openCents), 0);
	const payeesOpenCount = payees.filter((p) => cents(p.openCents) > 0).length;
	const bank = (iban: string | null | undefined, bic: string | null | undefined): string =>
		iban ? (bic ? `${iban}\n${bic}` : iban) : bic ? `–\n${bic}` : '–';
	const moneyOrDash = (value: number): string => (value > 0 ? money(value) : '–');
	if (payees.length > 0) {
		const purpose = `${input.actionName} Auslagen`.slice(0, 60);
		blocks.push({
			type: 'paragraph',
			text: `Verwendungszweck der Überweisungen: ${purpose}`
		});
		blocks.push({
			type: 'table',
			variant: 'grid',
			caption: {
				left: 'Erstattungen an Personen',
				...(payeesOpen > 0 ? { right: `noch offen: ${money(payeesOpen)}` } : {})
			},
			columns: ['Name', 'Bankverbindung', 'Gesamt', 'ausgezahlt', 'noch offen'],
			align: ['left', 'left', 'right', 'right', 'right'],
			widths: [3, 5, 2, 2, 2],
			rows: payees.map((p) => [
				p.name,
				bank(p.iban, p.bic),
				money(cents(p.openCents) + cents(p.reimbursedCents)),
				moneyOrDash(cents(p.reimbursedCents)),
				moneyOrDash(cents(p.openCents))
			]),
			totalRow: [
				{ text: 'Summe', colspan: 2 },
				money(payeesTotal),
				money(payeesPaid),
				money(payeesOpen)
			]
		});
	}

	// Offene Stamm-Ausgaben: Überweisung durch die Kasse steht noch aus
	const openClub = expenses.filter((e) => e.paidBy === 'club' && e.clubPaidAt === null);
	const openClubTotal = sum(openClub);
	if (openClub.length > 0) {
		blocks.push({
			type: 'table',
			variant: 'grid',
			caption: { left: 'Offene Überweisungen des Stamms', right: money(openClubTotal) },
			columns: ['Beleg-Nr.', 'Empfänger', 'Bankverbindung', 'Verwendungszweck', 'Betrag'],
			align: ['right', 'left', 'left', 'left', 'right'],
			widths: [2, 3, 4, 3, 2],
			rows: openClub.map((e) => [
				String(numbering.get(e.id)),
				e.recipient?.name ?? '–',
				bank(input.clubIbans?.[e.id] ?? e.recipient?.ibanMasked, e.recipient?.bic),
				e.purpose || e.description,
				money(e.amountCents)
			]),
			totalRow: [{ text: 'Summe', colspan: 4 }, money(openClubTotal)]
		});
	}

	const refund = interim ? null : (input.refund ?? null);
	const donation = refund ? donationTotals(refund.items.map(withDonation)) : null;
	if (refund && donation) {
		const donors = refund.items.map(withDonation).filter((i) => i.donatedCents > 0);
		if (donors.length === 0) {
			blocks.push({
				type: 'table',
				variant: 'grid',
				caption: { left: 'Rückzahlung an Teilnehmende', right: money(refund.totalCents) },
				columns: ['Teilnehmende*r', 'Betrag'],
				align: ['left', 'right'],
				widths: [9, 2],
				rows: refund.items.map((i) => [i.name, money(i.amountCents)])
			});
		} else {
			blocks.push({
				type: 'table',
				variant: 'grid',
				caption: { left: 'Rückzahlung an Teilnehmende', right: money(donation.payoutCents) },
				columns: ['Teilnehmende*r', 'Anteil', 'gespendet', 'Auszahlung'],
				align: ['left', 'right', 'right', 'right'],
				widths: [6, 2, 2, 2],
				rows: refund.items
					.map(withDonation)
					.map((i) => [
						i.name,
						money(i.amountCents),
						i.donatedCents > 0 ? money(i.donatedCents) : '–',
						money(i.amountCents - i.donatedCents)
					]),
				totalRow: [
					'Summe',
					money(refund.totalCents),
					money(donation.donatedCents),
					money(donation.payoutCents)
				]
			});
			blocks.push({
				type: 'table',
				variant: 'grid',
				caption: { left: 'An den Stamm gespendet', right: money(donation.donatedCents) },
				columns: ['Name', 'Betrag'],
				align: ['left', 'right'],
				widths: [9, 2],
				rows: donors.map((i) => [i.name, money(i.donatedCents)])
			});
		}
		blocks.push({
			type: 'paragraph',
			text: 'Hinweis: Die Rückzahlung erfolgt erst, sobald alle Zahlungen einschließlich der Zuschüsse eingegangen sind.'
		});
		blocks.push({
			type: 'paragraph',
			text: `Verbleibt in der Stammkasse: ${money(refund.remainderCents)}`
		});
	}

	const instructions: string[][] = [['Einnahmen insgesamt', money(s.incomeCents)]];
	if (payeesPaid > 0) {
		instructions.push([
			'Auslagen-Erstattungen an Personen – bereits ausgezahlt',
			`− ${money(payeesPaid)}`
		]);
	}
	if (payeesOpen > 0) {
		instructions.push([
			`Auslagen-Erstattungen an Personen – noch zu überweisen (${payeesOpenCount} ${payeesOpenCount === 1 ? 'Person' : 'Personen'})`,
			`− ${money(payeesOpen)}`
		]);
	}
	if (openClub.length > 0) {
		instructions.push([
			`Offene Überweisungen des Stamms (${openClub.length}) – noch zu überweisen`,
			`− ${money(openClubTotal)}`
		]);
	}
	if (refund && donation) {
		instructions.push(['Rückzahlung an Teilnehmende', `− ${money(donation.payoutCents)}`]);
		if (donation.donatedCents > 0) {
			instructions.push([
				`Davon an den Stamm gespendet (${donation.donorCount}, keine Auszahlung)`,
				money(donation.donatedCents)
			]);
		}
	}
	blocks.push({
		type: 'table',
		variant: 'grid',
		caption: { left: 'Buchungsanweisung für die Kasse' },
		noHeader: true,
		columns: ['Position', 'Betrag'],
		align: ['left', 'right'],
		widths: [9, 2],
		rows: instructions,
		totalRow: [
			interim ? 'Saldo zum Stichtag' : 'Verbleibt in der Stammkasse',
			money(s.balanceCents)
		]
	});

	if (s.missingReceipts > 0) {
		blocks.push({
			type: 'paragraph',
			text: `${s.missingReceipts} ${s.missingReceipts === 1 ? 'Ausgabe' : 'Ausgaben'} ohne Beleg.`
		});
	}
	const missing = input.missingAttachments ?? 0;
	if (missing > 0) {
		blocks.push({
			type: 'paragraph',
			text: `${missing} ${missing === 1 ? 'Beleg' : 'Belege'} nicht abrufbar bzw. nicht angehängt.`
		});
	}

	// --- Anlagenverzeichnis
	const withReceipt = expenses.filter((e) => e.receipt);
	if (withReceipt.length > 0) {
		const attached = input.attachedEntryIds ? new Set(input.attachedEntryIds) : null;
		blocks.push({
			type: 'table',
			variant: 'grid',
			caption: { left: 'Anlagenverzeichnis' },
			columns: ['Nr.', 'Bezeichnung', 'Betrag'],
			align: ['right', 'left', 'right'],
			widths: [1, 8, 2],
			rows: withReceipt.map((e) => [
				String(numbering.get(e.id)),
				attached && !attached.has(e.id) ? `${e.description} (nicht angehängt)` : e.description,
				money(e.amountCents)
			])
		});
	}

	return blocks;
}
