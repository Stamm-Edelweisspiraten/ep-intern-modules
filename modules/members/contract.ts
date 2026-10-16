import type { FieldDefinition, FormValue } from '$lib/forms';

/**
 * Vertrag der Dienste, die `members` abhängigen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.use<MembersService>('members', '<aufrufendes Modul>')`.
 * Alle Funktionen prüfen selbst, dass das Mitglied mit `ctx.userId` verknüpft ist.
 */
export interface LinkedMemberData {
	id: string;
	firstName: string;
	lastName: string;
	scoutName: string | null;
	/** JJJJ-MM-TT */
	birthDate: string;
	groups: { id: string; name: string }[];
	/** Erste hinterlegte E-Mail-Adresse */
	email: string | null;
	city: string;
	/** ISO-3166-Alpha-2 */
	country: string;
	/** Werte der Zusatzfelder (Schlüssel → Wert) */
	custom: Record<string, FormValue>;
}

export interface MemberFieldDefinition {
	key: string;
	field: FieldDefinition;
}

export interface MembersService {
	/** Mit dem Konto verknüpfte Mitglieder (`ctx.userId` Pflicht) */
	listLinkedMembers(ctx: import('$lib/sdk/types').RequestContext): Promise<LinkedMemberData[]>;
	/** 404, wenn das Mitglied nicht mit dem Konto verknüpft ist */
	getLinkedMember(
		ctx: import('$lib/sdk/types').RequestContext,
		memberId: string
	): Promise<LinkedMemberData>;
	/** Schreibt Werte der (aktiven) Zusatzfelder; gibt die tatsächlich geänderten Schlüssel zurück */
	updateMemberFields(
		ctx: import('$lib/sdk/types').RequestContext,
		memberId: string,
		values: Record<string, FormValue>
	): Promise<string[]>;
	/** Aktive Zusatzfelder (für den Formular-Builder anderer Module) */
	listFieldDefinitions(): Promise<MemberFieldDefinition[]>;
}
