import type { SubsidyInput, SubsidyLine, SubsidyResult } from './schemas';

/** Zuschusssaetze der Richtlinie 2026 in Cent je Person und Nacht. */
export const SUBSIDY_RATES_2026 = {
	external: {
		children: 1300,
		youth: 1400,
		/** 4 bis 14 Naechte, keine Konfi-Fahrt */
		longChildren: 1500,
		longYouth: 1600
	},
	parishRooms: { children: 300, youth: 400, minNights: 3 },
	allowance: { withJuleica: 1500, withoutJuleica: 1000 },
	maxNights: 14,
	childrenPerVolunteer: 5,
	youthPerVolunteer: 7
} as const;

function toCount(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Zuschuss und Taschengeld nach Richtlinie 2026. */
export function computeSubsidy(input: SubsidyInput): SubsidyResult {
	const R = SUBSIDY_RATES_2026;
	const nights = toCount(input.nights);
	const children = toCount(input.children);
	const teamYouth = toCount(input.teamYouth);
	const youth = toCount(input.youth);
	const youthTotal = youth + teamYouth;
	const teamWithJuleica = toCount(input.teamWithJuleica);
	const teamWithoutJuleica = toCount(input.teamWithoutJuleica);
	const cappedNights = Math.min(nights, R.maxNights);
	const warnings: string[] = [];

	let childRate = 0;
	let youthRate = 0;
	if (input.lodgingType === 'parish_rooms') {
		if (nights < R.parishRooms.minNights) {
			if (nights > 0) {
				warnings.push('Übernachtungen in Gemeinderäumen werden erst ab drei Nächten bezuschusst.');
			}
		} else {
			childRate = R.parishRooms.children;
			youthRate = R.parishRooms.youth;
		}
	} else if (nights > 0) {
		const long = cappedNights >= 4 && !input.konfi;
		childRate = long ? R.external.longChildren : R.external.children;
		youthRate = long ? R.external.longYouth : R.external.youth;
		if (cappedNights >= 4 && input.konfi) {
			warnings.push('Konfi-Fahrten erhalten nicht den erhöhten Satz für 4–14 Nächte.');
		}
	}
	if (nights > R.maxNights) warnings.push('Nur die ersten 14 Nächte sind zuschussfähig.');

	const lineNights = childRate > 0 ? cappedNights : 0;
	const mk = (
		key: 'children' | 'youth',
		label: string,
		count: number,
		rate: number
	): SubsidyLine => ({
		key,
		label,
		count,
		nights: lineNights,
		rateCents: rate,
		totalCents: count * lineNights * rate
	});
	const lines: SubsidyLine[] = [
		mk('children', 'Kinder (0–11 Jahre)', children, childRate),
		mk(
			'youth',
			teamYouth > 0 ? 'Jugendliche inkl. Teamer*innen (12–27 Jahre)' : 'Jugendliche (12–27 Jahre)',
			youthTotal,
			youthRate
		)
	];
	const subsidyCents = lines.reduce((s, l) => s + l.totalCents, 0);

	const limit =
		input.freizeitType === 'kids'
			? Math.floor(children / R.childrenPerVolunteer)
			: Math.floor(youthTotal / R.youthPerVolunteer);
	const withJuleica = Math.min(teamWithJuleica, limit);
	const withoutJuleica = Math.min(teamWithoutJuleica, limit - withJuleica);
	const allowanceTotal =
		(withJuleica * R.allowance.withJuleica + withoutJuleica * R.allowance.withoutJuleica) *
		cappedNights;

	if (teamWithJuleica + teamWithoutJuleica > limit) {
		warnings.push(
			`Es sind höchstens ${limit} Ehrenamtliche zuschussfähig (1 je 5 Kinder bzw. 7 Jugendliche).`
		);
	}
	if (children + youthTotal === 0) {
		warnings.push('Keine zuschussfähigen Teilnehmenden aus Bremen/Bremerhaven eingetragen.');
	}

	return {
		cappedNights,
		lines,
		subsidyCents,
		allowance: {
			limit,
			withJuleica,
			withoutJuleica,
			nights: cappedNights,
			totalCents: allowanceTotal
		},
		warnings
	};
}
