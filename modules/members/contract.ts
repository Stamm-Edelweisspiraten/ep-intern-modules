import type { FieldDefinition, FormValue } from '$lib/forms';
import type { MailCategory } from './schemas';

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
	phones: { name: string | null; value: string }[];
	emails: { name: string | null; value: string }[];
	/** Abgewählte, abschaltbare Mail-Kategorien */
	mailOptOut: MailCategory[];
}

export interface MemberFieldDefinition {
	key: string;
	field: FieldDefinition;
}

/** Kontaktdaten für Systemfunktionen anderer Module (z. B. Kasse: Zahler, Mails) */
export interface MemberContact {
	id: string;
	firstName: string;
	lastName: string;
	/** JJJJ-MM-TT */
	birthDate: string;
	/** Alle E-Mail-Adressen in Reihenfolge */
	emails: string[];
	street: string;
	postalCode: string;
	city: string;
	/** Eintritt/Austritt (JJJJ-MM-TT) oder null */
	entryDate: string | null;
	exitDate: string | null;
	secondaryMember: boolean;
	/** Ebenen, die bei uns gezahlt werden: Teilmenge von `stamm|gau|landesmark|bund` (bei Nicht-Zweitmitgliedern alle) */
	feeLevels: ('stamm' | 'gau' | 'landesmark' | 'bund')[];
	/** Abgewählte, abschaltbare Mail-Kategorien (Standard: leer = alle an) */
	mailOptOut: MailCategory[];
}

/** Alle Daten eines Mitglieds für Datenblätter (PDF) – inkl. Telefone und Zusatzfelder (Gesundheit) */
export interface MemberSheetData {
	id: string;
	firstName: string;
	lastName: string;
	scoutName: string | null;
	/** JJJJ-MM-TT */
	birthDate: string;
	/** Beschriftung des Stands (z. B. „Wölfling“) */
	stage: string;
	street: string;
	postalCode: string;
	city: string;
	/** ISO-3166-Alpha-2 */
	country: string;
	phones: { name: string | null; value: string }[];
	emails: { name: string | null; value: string }[];
	groups: { id: string; name: string }[];
	consentSocialMedia: boolean;
	consentWebsite: boolean;
	consentPrint: boolean;
	entryDate: string | null;
	exitDate: string | null;
	/** Werte der Zusatzfelder (Schlüssel → Wert) */
	custom: Record<string, FormValue>;
}

/** Gruppe für Auswahl/Freigaben anderer Module */
export interface MemberGroupRef {
	id: string;
	name: string;
	color: string | null;
	/** Gruppenbild (`/api/v1/modules/members/groups/<id>/image?v=…`) oder `null`; Abruf braucht `members.group.view` */
	image: string | null;
	/** Gruppenstunde: 1 = Mo … 7 = So, `HH:MM`, Treffpunkt (je `null`, wenn nicht hinterlegt) */
	meetingWeekday: number | null;
	meetingTime: string | null;
	meetingPlace: string | null;
}

/** Mitglied für Freigabe-Suche (Name = „Vorname Nachname“) */
export interface MemberPrincipalRef {
	id: string;
	name: string;
	groups: { id: string; name: string }[];
}

export interface MembersService {
	/** Alle Gruppen nach Name, ohne Rechteprüfung (nur Name/Farbe) */
	listGroups(): Promise<MemberGroupRef[]>;
	/**
	 * Für Freigaben: mit `userId` verknüpfte Mitglieder (ohne ausgetretene, Austritt ≤ heute) und deren
	 * Gruppen (Mitgliedschaft UND Leitung).
	 */
	principalIdsForUser(userId: string): Promise<{ memberIds: string[]; groupIds: string[] }>;
	/**
	 * Für Freigaben, ohne Rechteprüfung: `search` (ab 2 Zeichen, Vor-/Nach-/Pfadname, ohne ausgetretene)
	 * oder `ids` (≤ 100, auch ausgetretene); max. `limit` (Standard 20, höchstens 30).
	 */
	searchMembers(query: {
		search?: string;
		ids?: string[];
		limit?: number;
	}): Promise<MemberPrincipalRef[]>;

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
	/**
	 * Kontaktdaten ohne Verknüpfungs- oder Rechteprüfung – der AUFRUFER prüft seine eigenen Rechte.
	 * `ids` (≤ 1000) oder `search` (Vor-/Nach-/Pfadname); ohne beides alle (≤ `limit`, Standard 1000).
	 */
	listMemberContacts(query: {
		ids?: string[];
		search?: string;
		limit?: number;
	}): Promise<MemberContact[]>;
	/** Aktive Zusatzfelder (für den Formular-Builder anderer Module) */
	listFieldDefinitions(): Promise<MemberFieldDefinition[]>;
	/**
	 * Datenblätter (inkl. Telefone, Zusatzfelder) ohne Rechteprüfung – der AUFRUFER prüft sein Recht
	 * (`members.data.export`). Reihenfolge wie `ids` (≤ 200), unbekannte IDs entfallen.
	 */
	listMemberSheets(ids: string[]): Promise<MemberSheetData[]>;
}
