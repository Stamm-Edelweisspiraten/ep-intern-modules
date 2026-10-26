// Reine Logik für „Zahlung erfassen“ (Handy/Tablet): Tastenfeld, Zahler-Suche, Verteilung.
import type { OpenItemsGroup, OpenLine } from '../schemas';

/** Höchstbetrag der Eingabe (1 Mio. €) */
export const MAX_PAYMENT_CENTS = 100_000_000;

/** Tastenfeld: Ziffer, „00“ oder „back“ auf einen Betrag in Cent anwenden (nie über das Maximum) */
export function pressKey(cents: number, key: string): number {
	if (key === 'back') return Math.floor(cents / 10);
	const next = key === '00' ? cents * 100 : /^\d$/.test(key) ? cents * 10 + Number(key) : cents;
	return next <= MAX_PAYMENT_CENTS ? next : cents;
}

/** Vergleich ohne Groß-/Kleinschreibung und Umlaute (Müller = Muller, ß = ss) */
export function foldText(s: string): string {
	return s
		.toLocaleLowerCase('de')
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.replace(/ß/g, 'ss');
}

/** Zahler-Kandidaten: Suche über Name, Personen, Rechnungsnummern; passender Betrag zuerst */
export function paymentCandidates(
	groups: OpenItemsGroup[],
	search: string,
	amountCents: number
): OpenItemsGroup[] {
	const q = foldText(search.trim());
	const list = q
		? groups.filter((g) =>
				foldText(
					[g.label, ...g.invoices.flatMap((i) => [i.number, ...i.people, i.recipientName])].join(
						' '
					)
				).includes(q)
			)
		: groups;
	return [...list].sort(
		(a, b) =>
			Number(amountCents > 0 && b.openCents === amountCents) -
				Number(amountCents > 0 && a.openCents === amountCents) ||
			a.label.localeCompare(b.label, 'de')
	);
}

/** Offene Posten einer Gruppe: zuerst die bevorzugte Rechnung, sonst älteste Fälligkeit zuerst */
export function linesOfGroup(
	group: OpenItemsGroup | null,
	lines: OpenLine[],
	preferInvoiceId?: string | null
): OpenLine[] {
	if (!group) return [];
	const ids = new Set(group.invoices.map((i) => i.id));
	return lines
		.filter((l) => ids.has(l.invoiceId))
		.sort(
			(a, b) =>
				Number(b.invoiceId === preferInvoiceId) - Number(a.invoiceId === preferInvoiceId) ||
				a.dueOn.localeCompare(b.dueOn) ||
				a.invoiceNumber.localeCompare(b.invoiceNumber, 'de')
		);
}

/** Betrag der Reihe nach auf die Posten verteilen (je Posten höchstens offen) */
export function distributeOverLines(
	amountCents: number,
	lines: OpenLine[]
): Record<string, number> {
	let left = Math.max(0, Math.floor(amountCents));
	const out: Record<string, number> = {};
	for (const l of lines) {
		const take = Math.min(l.openCents, left);
		if (take > 0) out[l.lineId] = take;
		left -= take;
	}
	return out;
}
