/**
 * Jahresbeitrag (rein, ohne Server-Importe): Mitgliedschaft am Stichtag bzw. im Jahr, Beitragsebenen
 * je Mitglied und Planung der Rechnungen (eine Sammelrechnung je Zahler, sonst je Mitglied).
 *
 * Regeln:
 * - Mitglied am Tag D: (Eintritt fehlt oder ≤ D) und (Austritt fehlt oder > D).
 * - Lauf: Mitglied am Stichtag UND irgendwann im Beitragsjahr (Austritt ≤ 01.01. bzw. Eintritt nach
 *   dem 31.12. → kein Beitrag, auch wenn der Stichtag vor bzw. nach dem Jahr liegt).
 * - Nachberechnung: irgendwann im Beitragsjahr Mitglied und nicht vor/am Stichtag ausgetreten
 *   (wer zum Stichtag schon weg war, zahlt nicht nachträglich).
 * - Eintritt im Beitragsjahr nach dem 28.02. (der 29.02. zählt als danach) → nur Stammesbeitrag.
 * - Zweitmitglieder zahlen nur ihre `feeLevels`; bei spätem Eintritt nur `stamm`, falls enthalten.
 * - Posten mit 0 € entfallen; Mitglieder ohne Betrag landen in `skipped`.
 * - Eine Rechnung hat genau EINEN Posten (Stammesbeitrag = Summe aller Ebenen/Mitglieder); die Aufschlüsselung
 *   steht in `items`. Idempotenz: Mitglieder mit vorhandener Aufschlüsselung `annual:<jahr>:<mitglied>:<ebene>`
 *   (auch ältere Rechnungen mit Posten je Ebene) werden übersprungen.
 */
import type {
	AnnualPreview,
	AnnualPreviewInvoice,
	AnnualPreviewMember,
	FeeLevel,
	FeeRates
} from './schemas';
import { FEE_FULL_UNTIL, FEE_LEVEL_LABELS, FEE_LEVELS } from './schemas';

export interface AnnualMember {
	id: string;
	firstName: string;
	lastName: string;
	emails: string[];
	entryDate: string | null;
	exitDate: string | null;
	secondaryMember: boolean;
	feeLevels: readonly FeeLevel[];
}

export interface AnnualPayer {
	id: string;
	name: string;
	email: string | null;
}

export type AnnualNote = 'secondary' | 'late-entry' | null;

export interface PlannedLine {
	memberId: string;
	level: FeeLevel;
	amountCents: number;
	description: string;
	sourceRef: string;
}

/** Der EINE offene Posten einer Jahresbeitrags-Rechnung: Gesamtsumme aller Ebenen und Mitglieder */
export interface PlannedTotalLine {
	/** nur bei genau einem Mitglied gesetzt (Filter, Adresse), sonst null */
	memberId: string | null;
	description: string;
	amountCents: number;
}

export type PlannedInvoice = AnnualPreviewInvoice & {
	/** E-Mail der Rechnung (Zahler bzw. erste Adresse des Mitglieds) */
	recipientEmail: string | null;
	/** Rechnungsposten: genau einer (Stammesbeitrag = Summe) */
	lines: PlannedTotalLine[];
	/** Aufschlüsselung je Mitglied und Ebene (PDF, Idempotenz) */
	items: PlannedLine[];
};

export type AnnualPlan = Omit<AnnualPreview, 'invoices' | 'payerSuggestions'> & {
	invoices: PlannedInvoice[];
};

export const annualRef = (year: number, memberId: string, level: FeeLevel) =>
	`annual:${year}:${memberId}:${level}`;

/** Mitglied aus einem Idempotenz-Schlüssel (`annual:<jahr>:<mitglied>:<ebene>`) des Jahres */
export function memberIdOfRef(ref: string, year: number): string | null {
	const prefix = `annual:${year}:`;
	if (!ref.startsWith(prefix)) return null;
	const rest = ref.slice(prefix.length);
	const i = rest.lastIndexOf(':');
	return i > 0 ? rest.slice(0, i) : null;
}

export function isMemberOn(m: Pick<AnnualMember, 'entryDate' | 'exitDate'>, date: string): boolean {
	return (!m.entryDate || m.entryDate <= date) && (!m.exitDate || m.exitDate > date);
}

/** Irgendwann im Jahr Mitglied (Eintritt bis 31.12., Austritt nach dem 01.01.) */
export function isMemberInYear(
	m: Pick<AnnualMember, 'entryDate' | 'exitDate'>,
	year: number
): boolean {
	return (
		(!m.entryDate || m.entryDate <= `${year}-12-31`) &&
		(!m.exitDate || m.exitDate > `${year}-01-01`)
	);
}

/** Wird im Lauf (`run`) bzw. in der Nachberechnung (`catch-up`) abgerechnet? */
export function isBillable(
	m: Pick<AnnualMember, 'entryDate' | 'exitDate'>,
	year: number,
	stichtag: string,
	mode: 'run' | 'catch-up'
): boolean {
	if (!isMemberInYear(m, year)) return false;
	if (mode === 'run') return isMemberOn(m, stichtag);
	return !m.exitDate || m.exitDate > stichtag;
}

/** Eintritt im Beitragsjahr nach dem 28.02. */
export function isLateEntry(m: Pick<AnnualMember, 'entryDate'>, year: number): boolean {
	if (!m.entryDate || !m.entryDate.startsWith(`${year}-`)) return false;
	return m.entryDate.slice(5) > FEE_FULL_UNTIL;
}

/** Zu zahlende Ebenen eines Mitglieds im Beitragsjahr (in fester Reihenfolge) */
export function levelsFor(
	m: Pick<AnnualMember, 'entryDate' | 'secondaryMember' | 'feeLevels'>,
	year: number
): { levels: FeeLevel[]; note: AnnualNote } {
	const base: FeeLevel[] = m.secondaryMember
		? FEE_LEVELS.filter((l) => m.feeLevels.includes(l))
		: [...FEE_LEVELS];
	if (isLateEntry(m, year)) {
		return { levels: base.includes('stamm') ? ['stamm'] : [], note: 'late-entry' };
	}
	return { levels: base, note: m.secondaryMember ? 'secondary' : null };
}

export const memberName = (m: Pick<AnnualMember, 'firstName' | 'lastName'>) =>
	`${m.firstName} ${m.lastName}`.trim();

export function annualItemDescription(year: number, level: FeeLevel, name: string): string {
	return `Jahresbeitrag ${year} ${FEE_LEVEL_LABELS[level]} – ${name}`.slice(0, 200);
}

/** Bezeichnung des einen Rechnungspostens */
export const annualTotalDescription = (year: number) => `Jahresbeitrag ${year} – Stammesbeitrag`;

const cmp = (a: string, b: string) => a.localeCompare(b, 'de');

/**
 * Plant die Rechnungen eines Laufs (`run`: Mitglieder am Stichtag) bzw. einer Nachberechnung
 * (`catch-up`: Mitglieder irgendwann im Jahr). Ergebnis nach Empfängername sortiert.
 */
export function planAnnualInvoices(p: {
	members: AnnualMember[];
	payerOf: Map<string, AnnualPayer>;
	year: number;
	rates: FeeRates;
	existingRefs: Set<string>;
	mode: 'run' | 'catch-up';
	stichtag: string;
}): AnnualPlan {
	const billed = new Set<string>();
	for (const ref of p.existingRefs) {
		const id = memberIdOfRef(ref, p.year);
		if (id) billed.add(id);
	}
	const eligible = p.members
		.filter((m) => !billed.has(m.id))
		.filter((m) => isBillable(m, p.year, p.stichtag, p.mode))
		.sort(
			(a, b) => cmp(a.lastName, b.lastName) || cmp(a.firstName, b.firstName) || cmp(a.id, b.id)
		);

	const groups = new Map<string, PlannedInvoice>();
	const skipped: { memberId: string; name: string }[] = [];
	for (const m of eligible) {
		const name = memberName(m);
		const { levels, note } = levelsFor(m, p.year);
		const charged = levels.filter((l) => (p.rates[l] ?? 0) > 0);
		if (!charged.length) {
			skipped.push({ memberId: m.id, name });
			continue;
		}
		const lines: PlannedLine[] = charged.map((level) => ({
			memberId: m.id,
			level,
			amountCents: p.rates[level],
			description: annualItemDescription(p.year, level, name),
			sourceRef: annualRef(p.year, m.id, level)
		}));
		const member: AnnualPreviewMember = {
			memberId: m.id,
			name,
			levels: charged,
			note,
			totalCents: lines.reduce((s, l) => s + l.amountCents, 0)
		};
		const payer = p.payerOf.get(m.id);
		const key = payer ? `payer:${payer.id}` : `member:${m.id}`;
		let inv = groups.get(key);
		if (!inv) {
			inv = {
				key,
				payerId: payer?.id ?? null,
				recipientName: (payer ? payer.name : name).slice(0, 150),
				recipientEmail: payer ? payer.email : (m.emails[0] ?? null),
				emails: [],
				emailCount: 0,
				members: [],
				lines: [],
				items: [],
				totalCents: 0
			};
			groups.set(key, inv);
		}
		inv.members.push(member);
		inv.items.push(...lines);
		inv.totalCents += member.totalCents;
		const emails = new Set(inv.emails);
		for (const e of [...(payer?.email ? [payer.email] : []), ...m.emails]) {
			if (e && e.trim()) emails.add(e.trim().toLowerCase());
		}
		inv.emails = [...emails];
		inv.emailCount = inv.emails.length;
	}
	for (const inv of groups.values()) {
		inv.lines = [
			{
				memberId: inv.members.length === 1 ? inv.members[0]!.memberId : null,
				description: annualTotalDescription(p.year),
				amountCents: inv.totalCents
			}
		];
	}
	const invoices = [...groups.values()].sort(
		(a, b) => cmp(a.recipientName, b.recipientName) || cmp(a.key, b.key)
	);
	return {
		year: p.year,
		mode: p.mode,
		invoices,
		totalCents: invoices.reduce((s, i) => s + i.totalCents, 0),
		memberCount: invoices.reduce((s, i) => s + i.members.length, 0),
		withoutEmail: invoices
			.filter((i) => !i.emails.length)
			.flatMap((i) => i.members.map((m) => ({ memberId: m.memberId, name: m.name }))),
		skipped
	};
}

/** Vornamen für `{mitglieder}`: „Max“, „Max und Lena“, „Max, Lena und Tom“ */
export function joinNames(names: string[]): string {
	const list = [...new Set(names.filter(Boolean))];
	if (list.length <= 1) return list[0] ?? '';
	return `${list.slice(0, -1).join(', ')} und ${list[list.length - 1]}`;
}

/** Standard-Frist eines neuen Laufs: 31.03. des Beitragsjahres, sonst heute + Mindestfrist */
export function defaultAnnualDueOn(year: number, todayIso: string, minDays: number): string {
	const march = `${year}-03-31`;
	if (march > todayIso) return march;
	return addDaysIso(todayIso, minDays);
}

function addDaysIso(dateIso: string, days: number): string {
	const d = new Date(Date.parse(`${dateIso}T00:00:00Z`) + Math.max(0, days) * 86_400_000);
	return d.toISOString().slice(0, 10);
}

/**
 * Frist einer beim Versand erzeugten Rechnung: Frist des Laufs, solange sie nicht vor heute liegt,
 * sonst heute + Mindestfrist (z. B. Nachberechnung nach dem 31.03. oder Versand nach der Frist).
 */
export function annualInvoiceDueOn(runDueOn: string, todayIso: string, minDays: number): string {
	return runDueOn >= todayIso ? runDueOn : addDaysIso(todayIso, minDays);
}
