/**
 * Reine Kassen-Logik (ohne Server-/Svelte-Abhängigkeiten): Rechnungsstatus, Verteilung von
 * Zahlungen, Fälligkeit, Erinnerungsstufen, Abgleich mit Aktionen, Zahler-Vorschläge,
 * Zuordnungsvorschläge und Mail-Texte. Alle Beträge Integer-Cent, Daten `YYYY-MM-DD`.
 */
import { formatEuro } from '$lib/components/layout/money';
import { addDays, daysBetween, formatDateDe } from '$lib/sdk/dates';
import type { InvoiceStatus } from './schemas';

// Datumshelfer zentral in `$lib/sdk/dates` (#32); hier für bestehende Importe weitergereicht
export { addDays, daysBetween, formatDateDe };

export const maxDate = (a: string, b: string) => (a >= b ? a : b);

const safe = (n: number) => (Number.isFinite(n) ? Math.trunc(n) : 0);

// --- Status ------------------------------------------------------------------

export interface LineAmounts {
	amountCents: number;
	waivedCents: number;
	paidCents: number;
}

/** Gruppiert per Schlüssel in eine Map (Reihenfolge innerhalb der Gruppen bleibt erhalten) */
export function groupBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		const list = out.get(k);
		if (list) list.push(item);
		else out.set(k, [item]);
	}
	return out;
}

export function lineOpen(l: LineAmounts): number {
	return Math.max(0, safe(l.amountCents) - safe(l.waivedCents) - safe(l.paidCents));
}

export interface InvoiceTotals {
	totalCents: number;
	paidCents: number;
	openCents: number;
	creditCents: number;
	status: InvoiceStatus;
}

/**
 * Summen einer Rechnung. Stornierte Rechnungen schulden nichts; bereits Bezahltes wird dort
 * (wie eine Überzahlung) als Guthaben geführt.
 */
export function invoiceTotals(lines: LineAmounts[], cancelled: boolean): InvoiceTotals {
	const due = lines.reduce((s, l) => s + Math.max(0, safe(l.amountCents) - safe(l.waivedCents)), 0);
	const paid = lines.reduce((s, l) => s + Math.max(0, safe(l.paidCents)), 0);
	if (cancelled) {
		return {
			totalCents: due,
			paidCents: paid,
			openCents: 0,
			creditCents: paid,
			status: 'cancelled'
		};
	}
	const open = lines.reduce((s, l) => s + lineOpen(l), 0);
	const credit = lines.reduce(
		(s, l) =>
			s + Math.max(0, safe(l.paidCents) - Math.max(0, safe(l.amountCents) - safe(l.waivedCents))),
		0
	);
	const status: InvoiceStatus = open === 0 ? 'paid' : paid > 0 ? 'partial' : 'open';
	return { totalCents: due, paidCents: paid, openCents: open, creditCents: credit, status };
}

/** Tage überfällig (0 = nicht überfällig) */
export function overdueDays(dueOn: string, today: string, openCents: number): number {
	if (openCents <= 0) return 0;
	return Math.max(0, daysBetween(dueOn, today));
}

// --- Verteilung --------------------------------------------------------------

export interface OpenSlot {
	lineId: string;
	openCents: number;
	dueOn: string;
	/** Stabile Reihenfolge bei gleicher Fälligkeit */
	order?: string;
}

/** Verteilt einen Betrag auf offene Posten, älteste Fälligkeit zuerst. */
export function distribute(
	amountCents: number,
	slots: OpenSlot[]
): { allocations: { lineId: string; amountCents: number }[]; restCents: number } {
	let rest = Math.max(0, safe(amountCents));
	const sorted = [...slots]
		.filter((s) => s.openCents > 0)
		.sort(
			(a, b) =>
				a.dueOn.localeCompare(b.dueOn) ||
				(a.order ?? '').localeCompare(b.order ?? '') ||
				a.lineId.localeCompare(b.lineId)
		);
	const allocations: { lineId: string; amountCents: number }[] = [];
	for (const s of sorted) {
		if (rest <= 0) break;
		const take = Math.min(rest, s.openCents);
		allocations.push({ lineId: s.lineId, amountCents: take });
		rest -= take;
	}
	return { allocations, restCents: rest };
}

// --- Fälligkeit und Erinnerungen ---------------------------------------------

/**
 * Fälligkeit automatischer Rechnungen: `daysBeforeStart` Tage vor Beginn, aber nie früher als
 * `minDays` nach Erstellung (alte Aktionen lösen also nicht sofort Erinnerungen aus).
 */
export function computeDueOn(p: {
	startsOn: string;
	today: string;
	daysBeforeStart: number;
	minDays: number;
	override?: string | null;
}): string {
	if (p.override) return p.override;
	return maxDate(addDays(p.startsOn, -Math.max(0, p.daysBeforeStart)), addDays(p.today, p.minDays));
}

export const MAX_REMINDER_LEVEL = 2;

/**
 * Welche Erinnerungsstufe ist heute fällig? Stufe 1 ab `firstDays` Tagen Überfälligkeit,
 * Stufe 2 frühestens `secondDays` Tage nach Stufe 1. Danach keine automatische Erinnerung mehr.
 */
export function reminderLevelDue(p: {
	dueOn: string;
	today: string;
	openCents: number;
	cancelled: boolean;
	paused: boolean;
	sentLevel: number;
	lastReminderOn: string | null;
	firstDays: number;
	secondDays: number;
}): number | null {
	if (p.cancelled || p.paused || p.openCents <= 0) return null;
	const overdue = daysBetween(p.dueOn, p.today);
	if (p.sentLevel <= 0) return overdue >= p.firstDays ? 1 : null;
	if (p.sentLevel >= MAX_REMINDER_LEVEL) return null;
	const since = p.lastReminderOn ? daysBetween(p.lastReminderOn, p.today) : Infinity;
	return overdue >= p.firstDays + p.secondDays && since >= p.secondDays ? p.sentLevel + 1 : null;
}

// --- Abgleich mit Aktionen ------------------------------------------------------

/** Vergleichsform: Kleinbuchstaben, Umlaute als ae/oe/ue (Müller = Mueller), ohne Akzente */
export function normalizeName(s: string): string {
	return s
		.toLowerCase()
		.replace(/ä/g, 'ae')
		.replace(/ö/g, 'oe')
		.replace(/ü/g, 'ue')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/ß/g, 'ss')
		.replace(/[^a-z0-9ı]+/g, ' ')
		.trim();
}

export interface MemberLite {
	id: string;
	firstName: string;
	lastName: string;
	birthDate: string;
	emails: string[];
	street: string;
	postalCode: string;
	city: string;
}

/**
 * Ordnet Teilnehmende einem Mitglied zu: vorhandene Verknüpfung, sonst eindeutiger Treffer
 * auf Name + Geburtsdatum, ohne Geburtsdatum eindeutiger Name.
 */
export function matchMember(
	p: { memberId: string | null; name: string; birthDate: string | null },
	members: MemberLite[]
): string | null {
	if (p.memberId && members.some((m) => m.id === p.memberId)) return p.memberId;
	const name = normalizeName(p.name);
	const byName = members.filter((m) => normalizeName(`${m.firstName} ${m.lastName}`) === name);
	if (p.birthDate) {
		const exact = byName.filter((m) => m.birthDate === p.birthDate);
		return exact.length === 1 ? exact[0]!.id : null;
	}
	return byName.length === 1 ? byName[0]!.id : null;
}

export interface SyncSourceParticipant {
	id: string;
	name: string;
	role: 'participant' | 'team';
	birthDate: string | null;
	memberId: string | null;
	contactEmail: string | null;
}

export interface SyncSource {
	id: string;
	name: string;
	startsOn: string;
	feeCents: number;
	teamFeeCents: number | null;
	/** Aktion liegt in der Vergangenheit: Abgleich fasst ihre Posten nicht mehr an (eingefroren) */
	isPast?: boolean;
	participants: SyncSourceParticipant[];
}

export interface ExistingSyncLine {
	lineId: string;
	invoiceId: string;
	sourceRef: string;
	amountCents: number;
	waivedCents: number;
	description: string;
	memberId: string | null;
	cancelled: boolean;
	autoCancelled: boolean;
}

export interface DesiredLine {
	sourceRef: string;
	actionId: string;
	participantId: string;
	amountCents: number;
	description: string;
	recipientName: string;
	recipientEmail: string | null;
	memberId: string | null;
	dueOn: string;
}

export interface SyncPlan {
	create: DesiredLine[];
	update: {
		lineId: string;
		invoiceId: string;
		amountCents: number;
		waivedCents: number;
		description: string;
		memberId: string | null;
	}[];
	reactivate: { invoiceId: string }[];
	cancel: { invoiceId: string }[];
}

export const sourceRef = (actionId: string, participantId: string) =>
	`action:${actionId}:${participantId}`;

export function lineDescription(actionName: string, personName: string): string {
	return `Beitrag ${actionName} – ${personName}`.slice(0, 200);
}

/** Vergleicht gewünschte Posten (aus Aktionen) mit vorhandenen und plant die Änderungen. */
export function planSync(p: {
	sources: SyncSource[];
	excludedActionIds: Set<string>;
	dueOverrides: Map<string, string>;
	existing: ExistingSyncLine[];
	members: MemberLite[];
	today: string;
	daysBeforeStart: number;
	minDays: number;
}): SyncPlan {
	const desired = new Map<string, DesiredLine>();
	// Vergangene Aktionen sind eingefroren: weder neue Posten noch Aenderungen/Storno/Reaktivierung
	const frozen = new Set<string>();
	for (const s of p.sources) if (s.isPast && !p.excludedActionIds.has(s.id)) frozen.add(s.id);
	const frozenRef = (ref: string) => {
		const m = /^action:([^:]+):/.exec(ref);
		return !!m && frozen.has(m[1]!);
	};
	for (const s of p.sources) {
		if (p.excludedActionIds.has(s.id) || s.isPast) continue;
		for (const part of s.participants) {
			const amount = part.role === 'team' ? (s.teamFeeCents ?? 0) : s.feeCents;
			if (!(amount > 0)) continue;
			const ref = sourceRef(s.id, part.id);
			desired.set(ref, {
				sourceRef: ref,
				actionId: s.id,
				participantId: part.id,
				amountCents: amount,
				description: lineDescription(s.name, part.name),
				recipientName: part.name,
				recipientEmail: part.contactEmail,
				memberId: matchMember(part, p.members),
				dueOn: computeDueOn({
					startsOn: s.startsOn,
					today: p.today,
					daysBeforeStart: p.daysBeforeStart,
					minDays: p.minDays,
					override: p.dueOverrides.get(s.id) ?? null
				})
			});
		}
	}
	const plan: SyncPlan = { create: [], update: [], reactivate: [], cancel: [] };
	const seen = new Set<string>();
	for (const e of p.existing) {
		seen.add(e.sourceRef);
		if (frozenRef(e.sourceRef)) continue;
		const want = desired.get(e.sourceRef);
		if (!want) {
			if (!e.cancelled) plan.cancel.push({ invoiceId: e.invoiceId });
			continue;
		}
		if (e.cancelled) {
			// Manuell stornierte Rechnungen bleiben storniert
			if (!e.autoCancelled) continue;
			plan.reactivate.push({ invoiceId: e.invoiceId });
		}
		const memberId = e.memberId ?? want.memberId;
		if (
			e.amountCents !== want.amountCents ||
			e.description !== want.description ||
			memberId !== e.memberId
		) {
			plan.update.push({
				lineId: e.lineId,
				invoiceId: e.invoiceId,
				amountCents: want.amountCents,
				waivedCents: Math.min(e.waivedCents, want.amountCents),
				description: want.description,
				memberId
			});
		}
	}
	for (const [ref, want] of desired) if (!seen.has(ref)) plan.create.push(want);
	return plan;
}

// --- Zahler-Vorschläge ---------------------------------------------------------

/** Gruppiert Mitglieder ohne Zahler nach gemeinsamer E-Mail bzw. Anschrift (Geschwister). */
export function suggestPayers(
	members: MemberLite[],
	assigned: Set<string>
): { name: string; reason: string; memberIds: string[] }[] {
	const free = members.filter((m) => !assigned.has(m.id));
	const parent = new Map<string, string>(free.map((m) => [m.id, m.id]));
	const find = (x: string): string => {
		let r = x;
		while (parent.get(r) !== r) r = parent.get(r)!;
		return r;
	};
	const union = (a: string, b: string) => parent.set(find(a), find(b));
	const reasons = new Map<string, Set<string>>();
	const link = (key: string, label: string) => {
		const byKey = new Map<string, string[]>();
		for (const m of free) {
			const keys =
				key === 'email'
					? m.emails.map((e) => e.toLowerCase())
					: m.street && m.postalCode
						? [`${normalizeName(m.street)}|${m.postalCode}`]
						: [];
			for (const k of keys) byKey.set(k, [...(byKey.get(k) ?? []), m.id]);
		}
		for (const ids of byKey.values()) {
			if (ids.length < 2) continue;
			for (const id of ids.slice(1)) union(ids[0]!, id);
			for (const id of ids) reasons.set(id, (reasons.get(id) ?? new Set()).add(label));
		}
	};
	link('email', 'gleiche E-Mail-Adresse');
	link('address', 'gleiche Anschrift');
	const groups = new Map<string, MemberLite[]>();
	for (const m of free) groups.set(find(m.id), [...(groups.get(find(m.id)) ?? []), m]);
	return [...groups.values()]
		.filter((g) => g.length > 1)
		.map((g) => {
			const lastNames = [...new Set(g.map((m) => m.lastName))];
			const why = new Set(g.flatMap((m) => [...(reasons.get(m.id) ?? [])]));
			return {
				name: lastNames.length === 1 ? `Familie ${lastNames[0]}` : lastNames.join(' / '),
				reason: [...why].join(', '),
				memberIds: g.map((m) => m.id).sort()
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// --- Zuordnungsvorschläge ----------------------------------------------------

export interface MatchLine extends OpenSlot {
	invoiceId: string;
	invoiceNumber: string;
	/** Namen, die zu diesem Posten passen (Empfänger, Mitglied, Zahler) */
	names: string[];
	/** Gruppierung für Sammelzahlungen (Zahler-ID oder Nachname) */
	groupKey: string;
	/** Worum es geht (z. B. Name der Aktion); steht es im Verwendungszweck, zählt der Posten zuerst */
	topic?: string;
}

export interface MatchResult {
	confidence: 'high' | 'medium' | 'low';
	reason: string;
	allocations: { lineId: string; amountCents: number }[];
	invoiceNumbers: string[];
}

export function invoiceNumbersIn(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(/\bR-?\s?(\d{4})-\s?(\d{1,6})\b/gi)) {
		out.add(`R-${m[1]}-${m[2]!.padStart(4, '0')}`);
	}
	return [...out];
}

function nameMatches(haystack: string, name: string): boolean {
	const parts = normalizeName(name)
		.split(' ')
		.filter((p) => p.length >= 2);
	if (!parts.length) return false;
	const words = new Set(haystack.split(' '));
	// Vor- und Nachname (erstes und letztes Wort) müssen vorkommen; Einzelnamen genügen nicht
	if (parts.length === 1) return false;
	return words.has(parts[0]!) && words.has(parts[parts.length - 1]!);
}

function lastNameOf(name: string): string {
	const parts = normalizeName(name).split(' ');
	return parts[parts.length - 1] ?? '';
}

/**
 * Schlägt eine Verteilung für eine Einnahme vor. Reihenfolge: Rechnungsnummer im
 * Verwendungszweck, Namen (inkl. Geschwister mit gleichem Zahler/Nachnamen), exakter Betrag.
 */
export function suggestMatch(
	t: {
		amountCents: number;
		purpose: string | null;
		counterparty: string | null;
		/** Zahler, dessen hinterlegte IBAN zur Gegenpartei passt */
		payerId?: string | null;
	},
	lines: MatchLine[]
): MatchResult | null {
	const amount = t.amountCents;
	if (amount <= 0 || !lines.length) return null;
	const open = lines.filter((l) => l.openCents > 0);
	const sum = (ls: MatchLine[]) => ls.reduce((s, l) => s + l.openCents, 0);
	const numbersOf = (ls: MatchLine[]) => [...new Set(ls.map((l) => l.invoiceNumber))].sort();
	const result = (ls: MatchLine[], confidence: MatchResult['confidence'], reason: string) => {
		const d = distribute(amount, ls);
		return {
			confidence,
			reason,
			allocations: d.allocations,
			invoiceNumbers: numbersOf(ls.filter((l) => d.allocations.some((a) => a.lineId === l.lineId)))
		};
	};

	const text = `${t.purpose ?? ''} ${t.counterparty ?? ''}`;
	const numbers = invoiceNumbersIn(text);
	if (numbers.length) {
		const hit = open.filter((l) => numbers.includes(l.invoiceNumber));
		if (hit.length) {
			return result(
				hit,
				sum(hit) === amount ? 'high' : 'medium',
				`Rechnungsnummer im Verwendungszweck (${numbersOf(hit).join(', ')})`
			);
		}
	}

	const hay = normalizeName(text);
	const words = new Set(hay.split(' '));
	const topicHit = (l: MatchLine) =>
		normalizeName(l.topic ?? '')
			.split(' ')
			.some((w) => w.length >= 4 && !/^\d+$/.test(w) && words.has(w));

	// Bekannte Bankverbindung eines Zahlers: alle offenen Posten der Familie
	if (t.payerId) {
		const family = open.filter((l) => l.groupKey === `payer:${t.payerId}`);
		if (family.length) {
			const topical = family.filter(topicHit);
			const single = family.filter((l) => l.openCents === amount);
			if (sum(family) === amount)
				return result(family, 'high', 'Bankverbindung des Zahlers, Betrag passt');
			if (topical.length && sum(topical) === amount) {
				return result(topical, 'high', 'Bankverbindung des Zahlers und Posten im Verwendungszweck');
			}
			if (single.length === 1)
				return result(single, 'high', 'Bankverbindung des Zahlers, Betrag passt');
			return result(
				topical.length ? topical : family,
				'medium',
				'Bankverbindung des Zahlers, Betrag weicht ab'
			);
		}
	}
	// Thema (z. B. „Herbstfahrt“) im Verwendungszweck: Wörter ab 4 Zeichen, keine Jahreszahlen
	const mentioned = (l: MatchLine) =>
		normalizeName(l.topic ?? '')
			.split(' ')
			.some((w) => w.length >= 4 && !/^\d+$/.test(w) && words.has(w));
	const named = open.filter((l) => l.names.some((n) => nameMatches(hay, n)));
	if (named.length) {
		// Sammelzahlung: alle offenen Posten derselben Gruppe (Zahler/Nachname) einbeziehen
		const keys = new Set(named.map((l) => l.groupKey));
		const family = open.filter((l) => keys.has(l.groupKey));
		const namedTopic = named.filter(mentioned);
		const familyTopic = family.filter(mentioned);
		const exactNamed = named.filter((l) => l.openCents === amount);
		if (sum(named) === amount)
			return result(named, 'high', 'Name im Verwendungszweck, Betrag passt');
		if (namedTopic.length && sum(namedTopic) === amount) {
			return result(namedTopic, 'high', 'Name und Posten im Verwendungszweck, Betrag passt');
		}
		if (sum(family) === amount) {
			return result(family, 'high', 'Sammelzahlung für Geschwister, Betrag passt');
		}
		if (familyTopic.length && sum(familyTopic) === amount) {
			return result(familyTopic, 'high', 'Sammelzahlung für Geschwister, Posten und Betrag passen');
		}
		if (exactNamed.length === 1) {
			return result(exactNamed, 'high', 'Name im Verwendungszweck, Betrag passt');
		}
		const focus = namedTopic.length ? namedTopic : familyTopic.length ? familyTopic : family;
		return result(focus, 'medium', 'Name im Verwendungszweck, Betrag weicht ab');
	}

	// Nachname der Gegenpartei (z. B. „Mueller, Petra“) als schwacher Hinweis
	const counterLast = t.counterparty ? normalizeName(t.counterparty).split(' ') : [];
	const byLast = open.filter((l) => l.names.some((n) => counterLast.includes(lastNameOf(n))));
	if (byLast.length) {
		const keys = new Set(byLast.map((l) => l.groupKey));
		const family = open.filter((l) => keys.has(l.groupKey));
		if (sum(family) === amount)
			return result(family, 'medium', 'Nachname der Gegenpartei, Betrag passt');
	}

	const exact = new Map<string, MatchLine[]>();
	for (const l of open) exact.set(l.invoiceId, [...(exact.get(l.invoiceId) ?? []), l]);
	const exactInvoices = [...exact.values()].filter((ls) => sum(ls) === amount);
	if (exactInvoices.length === 1) {
		return result(exactInvoices[0]!, 'low', 'Nur der Betrag passt zu einer offenen Rechnung');
	}
	return null;
}

export interface PayableCandidate {
	id: string;
	recipientName: string;
	description: string;
	openCents: number;
	/** letzte vier Zeichen der hinterlegten IBAN */
	ibanLast4: string | null;
}

export interface PayableMatch {
	payableId: string;
	confidence: 'high' | 'medium' | 'low';
	reason: string;
}

/**
 * Vorschlag für eine Ausgabe: welche offene Auszahlung wird damit bezahlt?
 * IBAN-Ende + Betrag → sicher; Name + Betrag → sicher; Name allein → wahrscheinlich;
 * nur der Betrag (eindeutig) → unsicher.
 */
export function suggestPayable(
	t: {
		amountCents: number;
		counterparty: string | null;
		purpose: string | null;
		ibanLast4?: string | null;
	},
	candidates: PayableCandidate[]
): PayableMatch | null {
	const amount = Math.abs(t.amountCents);
	const open = candidates.filter((c) => c.openCents > 0);
	if (!amount || !open.length) return null;
	const hay = ` ${normalizeName(`${t.counterparty ?? ''} ${t.purpose ?? ''}`)} `;
	const nameHit = (c: PayableCandidate) => {
		const parts = normalizeName(c.recipientName)
			.split(' ')
			.filter((w) => w.length >= 3);
		const hits = parts.filter((w) => hay.includes(` ${w} `)).length;
		// mehrteilige Namen: zwei Wörter müssen passen (Vor- und Nachname, Firma + Ort …)
		return parts.length > 0 && hits >= Math.min(2, parts.length);
	};
	const pick = (
		list: PayableCandidate[],
		confidence: PayableMatch['confidence'],
		reason: string
	): PayableMatch | null => {
		if (!list.length) return null;
		// bei mehreren Treffern den mit dem passenden (bzw. nächsten) Betrag
		const best = [...list].sort(
			(a, b) => Math.abs(a.openCents - amount) - Math.abs(b.openCents - amount)
		)[0]!;
		return { payableId: best.id, confidence, reason };
	};
	const last4 = t.ibanLast4?.toUpperCase() ?? null;
	if (last4) {
		const byIban = open.filter((c) => c.ibanLast4?.toUpperCase() === last4);
		const exact = byIban.filter((c) => c.openCents === amount);
		const r =
			pick(exact, 'high', 'IBAN und Betrag passen') ??
			pick(byIban, 'medium', 'IBAN der Empfänger*in passt');
		if (r) return r;
	}
	const byName = open.filter(nameHit);
	const r =
		pick(
			byName.filter((c) => c.openCents === amount),
			'high',
			'Name und Betrag passen'
		) ?? pick(byName, 'medium', 'Name der Empfänger*in passt');
	if (r) return r;
	const byAmount = open.filter((c) => c.openCents === amount);
	if (byAmount.length === 1) {
		return { payableId: byAmount[0]!.id, confidence: 'low', reason: 'Nur der Betrag passt' };
	}
	return null;
}

// --- Mails ---------------------------------------------------------------------

export interface MailInvoice {
	number: string;
	recipientName: string;
	dueOn: string;
	lines: { description: string; cents: number }[];
}

export interface BankData {
	holder: string;
	iban: string;
	bic: string;
	name: string;
}

export function bankText(b: BankData): string {
	const iban = b.iban
		.replace(/\s+/g, '')
		.replace(/(.{4})/g, '$1 ')
		.trim();
	return [
		b.holder && `Kontoinhaber: ${b.holder}`,
		iban && `IBAN: ${iban}`,
		b.bic && `BIC: ${b.bic}`,
		b.name && `Bank: ${b.name}`
	]
		.filter(Boolean)
		.join('\n');
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
	return tpl.replace(/\{([a-z]+)\}/g, (m, key: string) => vars[key] ?? m);
}

/** Variablen für Bestätigung (`kind: 'paid'`) bzw. Erinnerung (`kind: 'reminder'`) */
export function mailVars(p: {
	invoices: MailInvoice[];
	bank: BankData;
	level?: number;
}): Record<string, string> {
	const lines = p.invoices.flatMap((inv) =>
		inv.lines.map((l) => `• ${inv.number}: ${l.description} – ${formatEuro(l.cents)}`)
	);
	const total = p.invoices.reduce((s, i) => s + i.lines.reduce((a, l) => a + l.cents, 0), 0);
	const names = [...new Set(p.invoices.map((i) => i.recipientName))];
	const numbers = p.invoices.map((i) => i.number);
	const due = p.invoices.map((i) => i.dueOn).sort()[0];
	return {
		name: names.join(', '),
		posten: lines.join('\n'),
		summe: formatEuro(total),
		rechnungen: numbers.join(', '),
		faellig: due ? formatDateDe(due) : '',
		kontodaten: bankText(p.bank) || '(Kontodaten fehlen in den Einstellungen)',
		verwendungszweck: `${numbers.join(' ')} ${names.join(', ')}`.slice(0, 140),
		stufe: String(p.level ?? 1)
	};
}

/** Betreff: einzeilig, max. 200 Zeichen */
export function mailSubject(tpl: string, vars: Record<string, string>): string {
	return (
		renderTemplate(tpl, vars)
			.replace(/[\r\n]+/g, ' ')
			.trim()
			.slice(0, 200) || 'Kasse'
	);
}

const EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

/** Fasst Rechnungen je Empfängeradresse zusammen (eine Mail je Adresse, z. B. für Geschwister). */
export function groupByAddress<T extends { addresses: string[] }>(items: T[]): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const it of items) {
		for (const raw of new Set(it.addresses.map((a) => a.trim().toLowerCase()))) {
			if (!EMAIL_RE.test(raw) || raw.length > 254) continue;
			out.set(raw, [...(out.get(raw) ?? []), it]);
		}
	}
	return out;
}

// CSV-Export: `csvDocument`/`csvCents` aus `$lib/sdk/csv`; Dateinamen: `safeFileName` aus `$lib/sdk/server` (#33/#34)

// --- Ausstehende Überweisungen (Abgleich) ---------------------------------------

/**
 * Schlüssel einer Auslagen-Auszahlung: Schlussabrechnung `reimb:<aktion>:<empfaenger>` (wie bisher),
 * Zwischenabrechnung `reimb:<aktion>:<empfaenger>:<zwischenabrechnung>`.
 */
export function reimbursementRef(
	actionId: string,
	payeeId: string,
	interimId?: string | null
): string {
	return interimId ? `reimb:${actionId}:${payeeId}:${interimId}` : `reimb:${actionId}:${payeeId}`;
}

/** Gegenstück zu `reimbursementRef`; `interimId: null` = Schlussabrechnung. */
export function parseReimbursementRef(
	ref: string
): { actionId: string; payeeId: string; interimId: string | null } | null {
	const parts = ref.split(':');
	if (parts[0] !== 'reimb' || parts.length < 3 || parts.length > 4) return null;
	const [, actionId, payeeId, interimId] = parts;
	if (!actionId || !payeeId) return null;
	if (parts.length === 4 && !interimId) return null;
	return { actionId, payeeId, interimId: interimId ?? null };
}

/** Beschreibung einer Auslagen-Auszahlung (Schlussabrechnung unverändert wie bisher). */
export function reimbursementDescription(
	recipientName: string,
	actionName: string,
	interimNumber?: number | null
): string {
	return (
		interimNumber
			? `Auslagen ${recipientName} – ${actionName}, Zwischenabrechnung Nr. ${interimNumber}`
			: `Auslagen ${actionName}`
	).slice(0, 200);
}

export interface PayableDesired {
	sourceRef: string;
	source: 'reimbursement' | 'refund' | 'credit' | 'expense';
	actionId: string | null;
	recipientName: string;
	description: string;
	amountCents: number;
	payerId: string | null;
	memberId: string | null;
	ibanLast4: string | null;
	bic: string | null;
	/** Verschlüsselte IBAN (z. B. Herkunftskonto des Beitrags); `null` = aus Quelle/Zahler */
	ibanEnc?: string | null;
}

export interface PayableExisting {
	id: string;
	sourceRef: string;
	amountCents: number;
	paidCents: number;
	description: string;
	recipientName: string;
	payerId: string | null;
	ibanLast4?: string | null;
	cancelled: boolean;
	autoCancelled: boolean;
}

export interface PayablePlan {
	create: PayableDesired[];
	update: { id: string; want: PayableDesired; amountCents: number }[];
	cancel: string[];
	reactivate: string[];
}

/**
 * Gleicht automatische Auszahlungen ab. Bereits (teil-)bezahlte Posten werden nie storniert und ihr
 * Betrag fällt nie unter das Gezahlte; manuell stornierte bleiben storniert.
 */
export function planPayables(desired: PayableDesired[], existing: PayableExisting[]): PayablePlan {
	const plan: PayablePlan = { create: [], update: [], cancel: [], reactivate: [] };
	const want = new Map(desired.filter((d) => d.amountCents > 0).map((d) => [d.sourceRef, d]));
	const seen = new Set<string>();
	for (const e of existing) {
		seen.add(e.sourceRef);
		const d = want.get(e.sourceRef);
		if (!d) {
			if (!e.cancelled && e.paidCents <= 0) plan.cancel.push(e.id);
			continue;
		}
		if (e.cancelled) {
			if (!e.autoCancelled) continue;
			plan.reactivate.push(e.id);
		}
		const amountCents = Math.max(d.amountCents, e.paidCents);
		if (
			amountCents !== e.amountCents ||
			d.description !== e.description ||
			d.recipientName !== e.recipientName ||
			d.payerId !== e.payerId ||
			(e.ibanLast4 !== undefined && (d.ibanLast4 ?? null) !== (e.ibanLast4 ?? null))
		) {
			plan.update.push({ id: e.id, want: d, amountCents });
		}
	}
	for (const [ref, d] of want) if (!seen.has(ref)) plan.create.push(d);
	return plan;
}

/**
 * GiroCode (EPC-QR, Version 002) für Banking-Apps. `null` ohne IBAN/Empfänger oder Betrag ≤ 0.
 * Felder: Name max. 70, Verwendungszweck max. 140 Zeichen.
 */
export function epcPayload(p: {
	holder: string;
	iban: string;
	bic?: string | null;
	amountCents: number;
	purpose: string;
}): string | null {
	const iban = p.iban.replace(/\s+/g, '').toUpperCase();
	if (!iban || !p.holder.trim() || !(p.amountCents > 0) || p.amountCents > 99_999_999_999)
		return null;
	const clean = (s: string, max: number) =>
		s
			.replace(/[\r\n]+/g, ' ')
			.trim()
			.slice(0, max);
	return [
		'BCD',
		'002',
		'1',
		'SCT',
		clean(p.bic ?? '', 11),
		clean(p.holder, 70),
		iban,
		`EUR${(p.amountCents / 100).toFixed(2)}`,
		'',
		'',
		clean(p.purpose, 140)
	].join('\n');
}
