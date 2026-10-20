import {
	CALC_CATEGORIES,
	type CalcCategory,
	type CalcLine,
	type CalculateInput,
	type CalculationResult
} from './schemas';

/** Negative/NaN/Infinity -> 0, sonst auf Ganzzahl abgerundet. */
function toCount(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Ganzzahliges Aufrunden von a / b (a >= 0, b > 0). */
function ceilDiv(a: number, b: number): number {
	return Math.floor(a / b) + (a % b === 0 ? 0 : 1);
}

/** Reine Berechnung der Kalkulation (Server und UI); arbeitet mit Integer-Cent. */
export function calculate(input: CalculateInput): CalculationResult {
	const payingParticipants = toCount(input.participants);
	const team = toCount(input.team);
	const nights = toCount(input.nights);
	const totalPersons = payingParticipants + team;
	const bufferPercent =
		typeof input.bufferPercent === 'number' && Number.isFinite(input.bufferPercent)
			? Math.max(0, input.bufferPercent)
			: 0;

	const pct =
		typeof input.teamPercent === 'number' && Number.isFinite(input.teamPercent)
			? Math.min(100, Math.max(0, input.teamPercent))
			: 0;
	const pctScaled = Math.round(pct * 100);
	const weightScaled = payingParticipants * 10000 + team * pctScaled;
	const payingWeight = weightScaled / 10000;

	const lines: CalcLine[] = (input.items ?? []).map((item) => {
		const amountCents = toCount(item.amountCents);
		const totalCents =
			item.basis === 'per_person_night'
				? amountCents * totalPersons * nights
				: item.basis === 'per_person'
					? amountCents * totalPersons
					: amountCents;
		return {
			id: item.id,
			category: item.category,
			label: item.label,
			basis: item.basis,
			amountCents,
			totalCents
		};
	});

	const sums = new Map<CalcCategory, number>();
	for (const l of lines) sums.set(l.category, (sums.get(l.category) ?? 0) + l.totalCents);

	const programRawCents = sums.get('program') ?? 0;
	const programPerPersonCents =
		weightScaled > 0 ? ceilDiv(programRawCents * 100, weightScaled) * 100 : programRawCents;
	const programTotalCents =
		weightScaled > 0 ? Math.round((programPerPersonCents * weightScaled) / 10000) : programRawCents;

	let nonProgram = 0;
	for (const [cat, sum] of sums) if (cat !== 'program') nonProgram += sum;
	const subtotalCents = nonProgram + programTotalCents;
	const bufferCents = Math.round((subtotalCents * bufferPercent) / 100);
	const totalCents = subtotalCents + bufferCents;
	const subsidyCents = Math.min(toCount(input.subsidyCents), totalCents);
	const netCents = Math.max(0, totalCents - subsidyCents);
	const perPersonCents = weightScaled > 0 ? (netCents * 10000) / weightScaled : 0;
	const recommendedPerPersonCents =
		weightScaled > 0 ? ceilDiv(netCents * 100, weightScaled) * 100 : 0;
	const teamPerPersonCents = team > 0 ? (perPersonCents * pctScaled) / 10000 : 0;
	const recommendedTeamPerPersonCents =
		team > 0 && pctScaled > 0
			? ceilDiv(recommendedPerPersonCents * pctScaled, 10000 * 100) * 100
			: 0;

	const byCategory: CalculationResult['byCategory'] = [];
	for (const category of CALC_CATEGORIES) {
		const total = category === 'program' ? programTotalCents : (sums.get(category) ?? 0);
		if (total > 0) {
			byCategory.push({ category, totalCents: total, share: total / subtotalCents });
		}
	}

	return {
		lines,
		payingParticipants,
		totalPersons,
		payingWeight,
		programRawCents,
		programPerPersonCents,
		programTotalCents,
		subtotalCents,
		bufferCents,
		totalCents,
		subsidyCents,
		netCents,
		perPersonCents,
		recommendedPerPersonCents,
		teamPerPersonCents,
		recommendedTeamPerPersonCents,
		byCategory
	};
}

const DAY_MS = 86_400_000;

function parseUtc(iso: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return null;
	const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return new Date(t).toISOString().slice(0, 10) === iso ? t : null;
}

/** Anzahl Nächte zwischen Start- und Enddatum (JJJJ-MM-TT); `null` ohne gültiges Enddatum. */
export function nightsBetween(startsOn: string, endsOn: string | null): number | null {
	if (!endsOn) return null;
	const s = parseUtc(startsOn);
	const e = parseUtc(endsOn);
	if (s === null || e === null || e < s) return null;
	return Math.round((e - s) / DAY_MS);
}
