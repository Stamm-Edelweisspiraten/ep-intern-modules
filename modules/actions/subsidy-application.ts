import {
	APPLICATION_ALLOWANCE_SLOTS,
	APPLICATION_CHILD_SLOTS,
	APPLICATION_YOUTH_SLOTS,
	ageAt,
	type ApplicationAllowance,
	type ApplicationPerson,
	type FreizeitType,
	type LeaderGender,
	type LodgingType,
	type SubsidyApplicationForm,
	type SubsidyApplicationPlan,
	type UnassignedReason
} from './schemas';
import { SUBSIDY_RATES_2026, allowanceLimit, computeSubsidy } from './subsidy';
import {
	deriveSubsidyCounts,
	effectiveSubsidyEligible,
	type EligibilityParticipant
} from './subsidy-eligibility';

/**
 * Reine Aufteilung der Zuschussberechtigten auf Antragsformulare des Landesjugendpfarramts.
 *
 * - Ein Formular fasst 20 Kinder (0–11), 20 Jugendliche (12–27, inkl. berechtigtem Team) und
 *   5 Taschengeld-Zeilen.
 * - Jeder Antrag braucht mindestens eine weibliche und eine männliche Leitung (Geschlecht nur aus dem
 *   Antrags-Dialog). Fehlen Leitungspaare, entstehen so viele Anträge wie möglich; der Rest steht in
 *   `unassigned`. Ohne jedes Paar gibt es trotzdem einen Antrag (mit Warnung).
 * - Klassifikation wie `deriveSubsidyCounts` (Zuschuss) bzw. Taschengeld-Kontingent (Team bis 27).
 * - Taschengelder je Antrag: 1 je 5 (Kinderfreizeit) bzw. 7 (Jugendfreizeit) Personen auf dem Antrag,
 *   Kinder und Jugendliche inkl. Team zusammen, abgerundet (`allowanceLimit`).
 */
export interface ApplicationPlanInput {
	participants: EligibilityParticipant[];
	startsOn: string;
	/** Nächte laut Kalkulation bzw. Datum */
	nights: number;
	lodgingType: LodgingType;
	konfi: boolean;
	freizeitType: FreizeitType;
	/** Geschlecht der Leitungen (participantId → Geschlecht) */
	genders: ReadonlyMap<string, LeaderGender>;
}

interface Draft {
	team: EligibilityParticipant[];
	children: ApplicationPerson[];
	youth: ApplicationPerson[];
	/** davon Team (für `computeSubsidy`) */
	teamYouth: number;
}

const byName = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, 'de', { sensitivity: 'base', numeric: true });

const person = (p: EligibilityParticipant): ApplicationPerson => ({
	participantId: p.id,
	name: p.name
});

/** Freien Antrag mit den wenigsten Einträgen wählen (gleich viele → kleinste Nummer). */
function leastFilled(drafts: Draft[], size: (d: Draft) => number, cap: number): Draft | null {
	let best: Draft | null = null;
	for (const d of drafts) {
		if (size(d) >= cap) continue;
		if (!best || size(d) < size(best)) best = d;
	}
	return best;
}

export function planSubsidyApplications(input: ApplicationPlanInput): SubsidyApplicationPlan {
	const nights = Number.isFinite(input.nights) && input.nights > 0 ? Math.floor(input.nights) : 0;
	const people = [...input.participants].sort(byName);
	const age = (p: EligibilityParticipant) =>
		p.birthDate ? ageAt(p.birthDate, input.startsOn) : null;
	const eligible = (p: EligibilityParticipant) => effectiveSubsidyEligible(p, input.startsOn);

	const team = people.filter((p) => p.role === 'team');
	const kids = people.filter((p) => p.role !== 'team' && eligible(p) && (age(p) ?? 99) <= 11);
	const youth = people.filter((p) => p.role !== 'team' && eligible(p) && (age(p) ?? -1) >= 12);
	const isTeamYouth = (p: EligibilityParticipant) => eligible(p) && (age(p) ?? -1) >= 12;
	const allowanceCandidate = (p: EligibilityParticipant) => {
		const a = age(p);
		return p.subsidyEligible !== false && a != null && a >= 0 && a <= 27;
	};

	const females = team.filter((p) => input.genders.get(p.id) === 'female');
	const males = team.filter((p) => input.genders.get(p.id) === 'male');
	const teamYouthTotal = team.filter(isTeamYouth).length;
	const neededForms = Math.max(
		1,
		Math.ceil(kids.length / APPLICATION_CHILD_SLOTS),
		Math.ceil((youth.length + teamYouthTotal) / APPLICATION_YOUTH_SLOTS)
	);
	const pairs = Math.min(females.length, males.length);
	const count = pairs > 0 ? Math.min(neededForms, pairs) : 1;

	const warnings: string[] = [];
	if (pairs === 0) {
		warnings.push(
			'Für den Antrag fehlt eine weibliche und/oder männliche Leitung. Bitte im Team das Geschlecht der Leitungen angeben.'
		);
	} else if (count < neededForms) {
		warnings.push(
			`Nötig wären ${neededForms} Anträge, es gibt aber nur ${pairs} Leitungspaare (je eine weibliche und eine männliche Leitung). Nicht alle Personen sind berücksichtigt.`
		);
	}
	const incomplete = deriveSubsidyCounts(people, input.startsOn).incomplete;
	if (incomplete.length) {
		warnings.push(
			incomplete.length === 1
				? '1 Person fehlt das Geburtsdatum oder der Wohnort – sie steht auf keinem Antrag.'
				: `${incomplete.length} Personen fehlt das Geburtsdatum oder der Wohnort – sie stehen auf keinem Antrag.`
		);
	}

	const drafts: Draft[] = Array.from({ length: count }, () => ({
		team: [],
		children: [],
		youth: [],
		teamYouth: 0
	}));
	// Leitungspaare zuerst, übriges Team gleichmäßig verteilen
	const placed = new Set<string>();
	for (let i = 0; i < count && i < pairs; i++) {
		for (const p of [females[i]!, males[i]!]) {
			drafts[i]!.team.push(p);
			placed.add(p.id);
		}
	}
	const rest = [
		...team.filter((p) => !placed.has(p.id) && input.genders.has(p.id)),
		...team.filter((p) => !placed.has(p.id) && !input.genders.has(p.id))
	];
	for (const p of rest) leastFilled(drafts, (d) => d.team.length, Infinity)!.team.push(p);

	const unassigned: (ApplicationPerson & { reason: UnassignedReason })[] = [];
	// Jugendliste: erst das Team des Antrags, dann Teilnehmende ausgeglichen
	for (const d of drafts) {
		for (const p of d.team.filter(isTeamYouth)) {
			if (d.youth.length >= APPLICATION_YOUTH_SLOTS) {
				unassigned.push({ ...person(p), reason: 'youth-full' });
				continue;
			}
			d.youth.push(person(p));
			d.teamYouth++;
		}
	}
	for (const p of youth) {
		const d = leastFilled(drafts, (x) => x.youth.length, APPLICATION_YOUTH_SLOTS);
		if (d) d.youth.push(person(p));
		else unassigned.push({ ...person(p), reason: 'youth-full' });
	}
	for (const p of kids) {
		const d = leastFilled(drafts, (x) => x.children.length, APPLICATION_CHILD_SLOTS);
		if (d) d.children.push(person(p));
		else unassigned.push({ ...person(p), reason: 'children-full' });
	}

	const R = SUBSIDY_RATES_2026;
	const forms: SubsidyApplicationForm[] = drafts.map((d, i) => {
		// Alle auf diesem Antrag zählen mit – auch das Team auf der Jugendliste
		const limit = allowanceLimit(d.children.length + d.youth.length, input.freizeitType);
		const slots = Math.min(limit, APPLICATION_ALLOWANCE_SLOTS);
		const candidates = d.team
			.filter(allowanceCandidate)
			.sort((a, b) => Number(b.juleica) - Number(a.juleica) || byName(a, b));
		const chosen = candidates.slice(0, slots);
		for (const p of candidates.slice(slots)) {
			unassigned.push({ ...person(p), reason: 'allowance-limit' });
		}
		const result = computeSubsidy({
			nights,
			lodgingType: input.lodgingType,
			konfi: input.konfi,
			freizeitType: input.freizeitType,
			children: d.children.length,
			youth: d.youth.length - d.teamYouth,
			teamYouth: d.teamYouth,
			teamWithJuleica: chosen.filter((p) => p.juleica).length,
			teamWithoutJuleica: chosen.filter((p) => !p.juleica).length
		});
		const allowance: ApplicationAllowance[] = chosen.map((p) => {
			const rateCents = p.juleica ? R.allowance.withJuleica : R.allowance.withoutJuleica;
			return {
				...person(p),
				juleica: p.juleica,
				nights: result.cappedNights,
				rateCents,
				totalCents: rateCents * result.cappedNights
			};
		});
		const leaders = (g: LeaderGender) =>
			d.team.filter((p) => input.genders.get(p.id) === g).map(person);
		return {
			number: i + 1,
			femaleLeaders: leaders('female'),
			maleLeaders: leaders('male'),
			children: d.children,
			youth: d.youth,
			allowance,
			nights,
			subsidyCents: result.subsidyCents,
			allowanceCents: allowance.reduce((s, a) => s + a.totalCents, 0)
		};
	});

	return { forms, neededForms, unassigned, warnings };
}
