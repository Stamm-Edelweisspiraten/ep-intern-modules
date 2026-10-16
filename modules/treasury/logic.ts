/**
 * Reine Kassen-Logik (ohne Server-/Svelte-Abhaengigkeiten): Rechnungsstatus, Verteilung von
 * Zahlungen, Faelligkeit, Erinnerungsstufen, Abgleich mit Aktionen, Zahler-Vorschlaege,
 * Zuordnungsvorschlaege und Mail-Texte. Alle Betraege Integer-Cent, Daten `YYYY-MM-DD`.
 */
import { formatEuro } from '$lib/components/layout/money';
import type { InvoiceStatus } from './schemas';

const DAY_MS = 86_400_000;

const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
	return fromUtc(toUtc(date) + days * DAY_MS);
}

/** Ganze Tage von `a` nach `b` (positiv, wenn `b` spaeter liegt) */
export function daysBetween(a: string, b: string): number {
	return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export const maxDate = (a: string, b: string) => (a >= b ? a : b);

export function formatDateDe(d: string): string {
	const [y, m, day] = d.split('-');
	return `${day}.${m}.${y}`;
}

const safe = (n: number) => (Number.isFinite(n) ? Math.trunc(n) : 0);

// --- Status ------------------------------------------------------------------

export interface LineAmounts {
	amountCents: number;
	waivedCents: number;
	paidCents: number;
}

/** Offener Betrag eines Postens (nie negativ) */
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
 * (wie eine Ueberzahlung) als Guthaben gefuehrt.
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

/** Tage ueberfaellig (0 = nicht ueberfaellig) */
export function overdueDays(dueOn: string, today: string, openCents: number): number {
	if (openCents <= 0) return 0;
	return Math.max(0, daysBetween(dueOn, today));
}

// --- Verteilung --------------------------------------------------------------

export interface OpenSlot {
	lineId: string;
	openCents: number;
	dueOn: string;
	/** Stabile Reihenfolge bei gleicher Faelligkeit */
	order?: string;
}

/** Verteilt einen Betrag auf offene Posten, aelteste Faelligkeit zuerst. */
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

// --- Faelligkeit und Erinnerungen ---------------------------------------------

/**
 * Faelligkeit automatischer Rechnungen: `daysBeforeStart` Tage vor Beginn, aber nie frueher als
 * `minDays` nach Erstellung (alte Aktionen loesen also nicht sofort Erinnerungen aus).
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
 * Welche Erinnerungsstufe ist heute faellig? Stufe 1 ab `firstDays` Tagen Ueberfaelligkeit,
 * Stufe 2 fruehestens `secondDays` Tage nach Stufe 1. Danach keine automatische Erinnerung mehr.
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
 * Ordnet Teilnehmende einem Mitglied zu: vorhandene Verknuepfung, sonst eindeutiger Treffer
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

/** Vergleicht gewuenschte Posten (aus Aktionen) mit vorhandenen und plant die Aenderungen. */
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
	for (const s of p.sources) {
		if (p.excludedActionIds.has(s.id)) continue;
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

// --- Zahler-Vorschlaege ---------------------------------------------------------

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

// --- Zuordnungsvorschlaege ----------------------------------------------------

export interface MatchLine extends OpenSlot {
	invoiceId: string;
	invoiceNumber: string;
	/** Namen, die zu diesem Posten passen (Empfaenger, Mitglied, Zahler) */
	names: string[];
	/** Gruppierung fuer Sammelzahlungen (Zahler-ID oder Nachname) */
	groupKey: string;
	/** Worum es geht (z. B. Name der Aktion); steht es im Verwendungszweck, zaehlt der Posten zuerst */
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
	// Vor- und Nachname (erstes und letztes Wort) muessen vorkommen; Einzelnamen genuegen nicht
	if (parts.length === 1) return false;
	return words.has(parts[0]!) && words.has(parts[parts.length - 1]!);
}

function lastNameOf(name: string): string {
	const parts = normalizeName(name).split(' ');
	return parts[parts.length - 1] ?? '';
}

/**
 * Schlaegt eine Verteilung fuer eine Einnahme vor. Reihenfolge: Rechnungsnummer im
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
	// Thema (z. B. „Herbstfahrt“) im Verwendungszweck: Woerter ab 4 Zeichen, keine Jahreszahlen
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

/** Variablen fuer Bestaetigung (`kind: 'paid'`) bzw. Erinnerung (`kind: 'reminder'`) */
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

/** Fasst Rechnungen je Empfaengeradresse zusammen (eine Mail je Adresse, z. B. fuer Geschwister). */
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

// --- CSV-Export ----------------------------------------------------------------

/** Schutz gegen Formel-Injection und Trennzeichen */
export function csvCell(v: string | number | null | undefined): string {
	let s = v == null ? '' : String(v);
	const numeric = typeof v === 'number' || /^-?\d+(,\d+)?$/.test(s);
	if (/^[=+\-@\t\r]/.test(s) && !numeric) s = `'${s}`;
	return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvDocument(header: string[], rows: (string | number | null)[][]): string {
	return '\ufeff' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export const centsToCsv = (c: number) => (c / 100).toFixed(2).replace('.', ',');

/** Dateiname fuer Storage-Pfade und Content-Disposition */
export function sanitizeName(name: string): string {
	const cleaned = name
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._]+/, '')
		.slice(-100);
	return cleaned || 'datei';
}

// --- Ausstehende Ueberweisungen (Abgleich) ---------------------------------------

export interface PayableDesired {
	sourceRef: string;
	source: 'reimbursement' | 'refund' | 'credit';
	actionId: string | null;
	recipientName: string;
	description: string;
	amountCents: number;
	payerId: string | null;
	memberId: string | null;
	ibanLast4: string | null;
	bic: string | null;
}

export interface PayableExisting {
	id: string;
	sourceRef: string;
	amountCents: number;
	paidCents: number;
	description: string;
	recipientName: string;
	payerId: string | null;
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
 * Betrag faellt nie unter das Gezahlte; manuell stornierte bleiben storniert.
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
			d.payerId !== e.payerId
		) {
			plan.update.push({ id: e.id, want: d, amountCents });
		}
	}
	for (const [ref, d] of want) if (!seen.has(ref)) plan.create.push(d);
	return plan;
}
