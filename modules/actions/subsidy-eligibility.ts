import { ageAt, type ParticipantRole } from './schemas';

/**
 * Reine Klassifikation der Zuschussberechtigung (Server, Vorschlaege und Abrechnung).
 *
 * Effektiv berechtigt:
 * - `subsidyEligible === false`: nie.
 * - Alter zum Aktionsstart nicht bestimmbar oder nicht 0-27: nie.
 * - `subsidyEligible === true`: ja (Wohnort egal).
 * - `null` (automatisch): nur mit Wohnort Bremen/Bremerhaven (`bremenResident === true`).
 */
export interface EligibilityParticipant {
	id: string;
	name: string;
	role: ParticipantRole;
	birthDate: string | null;
	bremenResident: boolean | null;
	juleica: boolean;
	subsidyEligible: boolean | null;
}

export interface SubsidyCounts {
	bremenChildren: number;
	bremenYouth: number;
	teamWithJuleica: number;
	teamWithoutJuleica: number;
	/** Team (Rolle Team) 12-27 Jahre, effektiv berechtigt */
	teamYouth: number;
	incomplete: { id: string; name: string; missing: ('birthDate' | 'bremenResident')[] }[];
}

function ageOf(p: EligibilityParticipant, startsOn: string): number | null {
	return p.birthDate ? ageAt(p.birthDate, startsOn) : null;
}

export function effectiveSubsidyEligible(p: EligibilityParticipant, startsOn: string): boolean {
	if (p.subsidyEligible === false) return false;
	const age = ageOf(p, startsOn);
	if (age == null || age < 0 || age > 27) return false;
	if (p.subsidyEligible === true) return true;
	return p.bremenResident === true;
}

export function deriveSubsidyCounts(
	participants: EligibilityParticipant[],
	startsOn: string
): SubsidyCounts {
	const out: SubsidyCounts = {
		bremenChildren: 0,
		bremenYouth: 0,
		teamWithJuleica: 0,
		teamWithoutJuleica: 0,
		teamYouth: 0,
		incomplete: []
	};
	for (const p of participants ?? []) {
		const isTeam = p.role === 'team';
		const age = ageOf(p, startsOn);
		const missing: ('birthDate' | 'bremenResident')[] = [];
		if (age == null && p.subsidyEligible !== false) missing.push('birthDate');
		if (p.bremenResident == null && p.subsidyEligible == null) missing.push('bremenResident');
		if (missing.length) out.incomplete.push({ id: p.id, name: p.name, missing });

		// Taschengeld-Kontingent: Team bis 27 (unabhaengig vom Wohnort), ausser ausdruecklich ausgeschlossen
		if (isTeam && p.subsidyEligible !== false && age != null && age >= 0 && age <= 27) {
			if (p.juleica) out.teamWithJuleica++;
			else out.teamWithoutJuleica++;
		}
		if (!effectiveSubsidyEligible(p, startsOn) || age == null) continue;
		if (isTeam) {
			if (age >= 12) out.teamYouth++;
		} else if (age <= 11) out.bremenChildren++;
		else out.bremenYouth++;
	}
	return out;
}
