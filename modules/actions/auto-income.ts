import { computeSubsidy } from './subsidy';
import { deriveSubsidyCounts, type EligibilityParticipant } from './subsidy-eligibility';
import type { AutoIncome, EntryType, FreizeitType, LodgingType } from './schemas';

/** Reine Berechnung der automatischen Einnahmen (Beitraege, Zuschuss) aus Teilnehmerliste und Kalkulation. */

export interface AutoIncomeInput {
	feeCents: number | null;
	teamFeeCents: number | null;
	/** Rolle Teilnehmer*in / Team laut Liste */
	payingCount: number;
	teamCount: number;
	/** `null`, wenn keine Kalkulation gespeichert oder `include_subsidy` aus */
	subsidy: null | {
		nights: number;
		lodgingType: LodgingType;
		konfi: boolean;
		freizeitType: FreizeitType;
		startsOn: string;
		participants: EligibilityParticipant[];
	};
	/** Manuelle Buchungen (nur Typ und Kategorie noetig) */
	entries: { type: EntryType; category: string }[];
}

const nat = (v: unknown): number =>
	typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

export function computeAutoIncome(input: AutoIncomeInput): AutoIncome {
	let contributions: AutoIncome['contributions'] = null;
	if (input.feeCents != null) {
		const feeCents = nat(input.feeCents);
		const teamFeeCents = nat(input.teamFeeCents);
		const payingCount = nat(input.payingCount);
		const teamCount = nat(input.teamCount);
		contributions = {
			cents: payingCount * feeCents + teamCount * teamFeeCents,
			payingCount,
			teamCount,
			feeCents,
			teamFeeCents
		};
	}
	let subsidy: AutoIncome['subsidy'] = null;
	if (input.subsidy) {
		const s = input.subsidy;
		const counts = deriveSubsidyCounts(s.participants, s.startsOn);
		const r = computeSubsidy({
			nights: s.nights,
			lodgingType: s.lodgingType,
			konfi: s.konfi,
			freizeitType: s.freizeitType,
			children: counts.bremenChildren,
			youth: counts.bremenYouth,
			teamWithJuleica: counts.teamWithJuleica,
			teamWithoutJuleica: counts.teamWithoutJuleica,
			teamYouth: counts.teamYouth
		});
		subsidy = {
			cents: r.subsidyCents,
			eligibleCount: counts.bremenChildren + counts.bremenYouth + counts.teamYouth
		};
	}
	const overridden: AutoIncome['overridden'] = [];
	const manual = (c: string): boolean =>
		(input.entries ?? []).some((e) => e.type === 'income' && e.category === c);
	if (contributions && manual('contributions')) overridden.push('contributions');
	if (subsidy && manual('subsidy')) overridden.push('subsidy');
	return { contributions, subsidy, overridden };
}

/** Automatisch zaehlende Betraege (ohne ueberschriebene Kategorien). */
export function appliedAutoIncome(auto: AutoIncome | null | undefined): {
	contributionsCents: number;
	subsidyCents: number;
} {
	if (!auto) return { contributionsCents: 0, subsidyCents: 0 };
	return {
		contributionsCents:
			auto.contributions && !auto.overridden.includes('contributions')
				? auto.contributions.cents
				: 0,
		subsidyCents: auto.subsidy && !auto.overridden.includes('subsidy') ? auto.subsidy.cents : 0
	};
}
