import type { FieldDefinition, FormValue } from '$lib/forms';
import type {
	PrincipalGroupRef,
	PrincipalMemberRef,
	PrincipalProvider
} from '$lib/sdk/types/sharing';
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

/** Von einem Konto geleitete Gruppe (für Absender des Moduls `messages`) */
export interface LedGroupRef {
	id: string;
	name: string;
	/** Kontakt-E-Mail der Gruppe (Website-Steckbrief) oder `null` */
	email: string | null;
}

/** Gruppe mit Kontakt-E-Mail und den Konten ihrer Leitungen (Postfach im Modul `messages`) */
export interface GroupMailbox {
	id: string;
	name: string;
	/** Kontakt-E-Mail der Gruppe (nie leer) */
	email: string;
	/** Konten, deren eigenes, aktives Mitglied die Gruppe leitet */
	leaderUserIds: string[];
}

/** Gruppe für Auswahl/Freigaben anderer Module (Vertrag im SDK, siehe `PrincipalGroupRef`) */
export type MemberGroupRef = PrincipalGroupRef;

/** Mitglied für Freigabe-Suche (Name = „Vorname Nachname“, Vertrag im SDK) */
export type MemberPrincipalRef = PrincipalMemberRef;

/**
 * `listGroups`, `principalIdsForUser` und `searchMemberPrincipals` stammen aus `PrincipalProvider`
 * (`$lib/sdk/types/sharing`) – eine Quelle für SDK und `members`.
 */
export interface MembersService extends PrincipalProvider {
	/**
	 * Für Systemfunktionen anderer Module, OHNE Rechteprüfung (der Aufrufer prüft seine Rechte):
	 * `search` (ab 2 Zeichen, Vor-/Nach-/Pfadname, ohne ausgetretene) oder `ids` (≤ 100, auch
	 * ausgetretene); max. `limit` (Standard 20, höchstens 30). Für Freigaben `searchMemberPrincipals`.
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
	/**
	 * Aktuelle (nicht ausgetretene, nicht anonymisierte) Mitglieder je Gruppe, ohne Rechteprüfung – der
	 * Aufrufer prüft seine Rechte. Höchstens 50 Gruppen; Schlüssel = alle übergebenen Gruppen-IDs.
	 */
	listGroupMemberIds(groupIds: string[]): Promise<Record<string, string[]>>;
	/** Gruppen, die das Konto über sein eigenes, aktives Mitglied leitet (leer ohne Konto/Leitung) */
	listLedGroups(ctx: import('$lib/sdk/types').RequestContext): Promise<LedGroupRef[]>;
	/**
	 * Vor- und Nachname des als **eigenes Konto** verknüpften Mitglieds (`is_self`, nur von der Verwaltung
	 * gesetzt) oder `null`. Eltern-Verknüpfungen zählen nie.
	 */
	getOwnMemberName(
		ctx: import('$lib/sdk/types').RequestContext
	): Promise<{ firstName: string; lastName: string } | null>;
	/**
	 * Systemweit, ohne Rechteprüfung (Postfach-Zuordnung in `messages`): Namen aller als **eigenes Konto**
	 * verknüpften, nicht anonymisierten Mitglieder (je Konto höchstens ein Eintrag).
	 */
	listSelfMemberNames(): Promise<{ userId: string; firstName: string; lastName: string }[]>;
	/** Systemweit, ohne Rechteprüfung: alle Gruppen mit Kontakt-E-Mail und ihren Leitungs-Konten */
	listGroupMailboxes(): Promise<GroupMailbox[]>;
	/**
	 * Systemweit, ohne Rechteprüfung: mit den Mitgliedern verknüpfte Konten (Mitglied → Konto-IDs), z. B. für
	 * Push-Benachrichtigungen der Kasse. Höchstens 2000 Mitglieder; Mitglieder ohne Verknüpfung fehlen.
	 */
	listLinkedUserIds(memberIds: string[]): Promise<Record<string, string[]>>;
	/** Aktive Zusatzfelder (für den Formular-Builder anderer Module) */
	listFieldDefinitions(): Promise<MemberFieldDefinition[]>;
	/**
	 * Datenblätter (inkl. Telefone, Zusatzfelder) ohne Rechteprüfung – der AUFRUFER prüft sein Recht
	 * (`members.data.export`). Reihenfolge wie `ids` (≤ 200), unbekannte IDs entfallen.
	 */
	listMemberSheets(ids: string[]): Promise<MemberSheetData[]>;
}
