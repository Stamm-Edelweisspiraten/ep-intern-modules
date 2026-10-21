/**
 * API-Vertrag des Moduls `offices` (Ämter): Zod-Eingaben, DTO-Typen, Konstanten.
 * Wird von Server UND UI genutzt – keine Server-Imports.
 */
import { z } from 'zod';
import { isRealDate } from '$lib/sdk/dates';

export const MODULE_ID = 'offices';
export const BASE_PATH = '/modules/offices';

/**
 * Rolle, die jede*r Inhaber*in eines Amts automatisch erhält (per Name gesucht/angelegt über
 * `defaultRoleGrants`). Bringt `offices.office.view` mit – damit sehen Inhaber*innen die Ämter und
 * pflegen ihre persönliche Beschreibung, auch wenn die Amt-Rollen das Recht nicht enthalten.
 */
export const HOLDER_ROLE_NAME = 'Amtsinhaber*in';

export const MAX_NAME = 100;
export const MAX_DESCRIPTION = 5000;
export const MAX_BIO = 2000;
export const MAX_EMAILS = 10;
export const MAX_ROLES = 20;
export const MAX_HOLDERS = 50;
export const MAX_OFFICES = 200;

/** Echtes Kalenderdatum `JJJJ-MM-TT` */
// Zentral in `$lib/sdk/dates` (#32); hier für bestehende Importe weitergereicht
export { isRealDate };

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.nullish()
		.transform((v) => (v ? v : null));

export const idParams = z.object({ id: z.uuid() });
export const userIdParams = z.object({ userId: z.string().min(1).max(100) });

export const emailInput = z.object({
	label: optionalText(60),
	email: z.string().trim().toLowerCase().max(254).email('Ungültige E-Mail-Adresse')
});
export type EmailInput = z.input<typeof emailInput>;

/** Doppelte Adressen (ohne Groß-/Kleinschreibung) innerhalb eines Amts ablehnen */
const emailList = z
	.array(emailInput)
	.max(MAX_EMAILS, `Höchstens ${MAX_EMAILS} E-Mail-Adressen`)
	.superRefine((list, ctx) => {
		const seen = new Set<string>();
		list.forEach((e, i) => {
			if (seen.has(e.email)) {
				ctx.addIssue({ code: 'custom', path: [i, 'email'], message: 'Adresse doppelt' });
			}
			seen.add(e.email);
		});
	});

const roleIdList = z
	.array(z.string().min(1).max(100))
	.max(MAX_ROLES, `Höchstens ${MAX_ROLES} Rollen`)
	.transform((ids) => [...new Set(ids)]);

/** Anlegen: alles außer dem Namen optional. Neue Ämter landen am Ende der Reihenfolge. */
export const officeCreateInput = z.object({
	name: z.string().trim().min(1, 'Pflichtfeld').max(MAX_NAME, `Höchstens ${MAX_NAME} Zeichen`),
	description: optionalText(MAX_DESCRIPTION),
	emails: emailList.default([]),
	roleIds: roleIdList.default([])
});
export type OfficeCreateInput = z.input<typeof officeCreateInput>;

/** Ändern: nur übergebene Felder; `emails`/`roleIds` ersetzen die Liste komplett. */
export const officeUpdateInput = z
	.object({
		name: z.string().trim().min(1, 'Pflichtfeld').max(MAX_NAME, `Höchstens ${MAX_NAME} Zeichen`),
		description: optionalText(MAX_DESCRIPTION),
		emails: emailList,
		roleIds: roleIdList
	})
	.partial();
export type OfficeUpdateInput = z.input<typeof officeUpdateInput>;

/** Neue Reihenfolge: alle Amt-IDs genau einmal (sonst 422) */
export const officeOrderInput = z.object({
	ids: z
		.array(z.uuid())
		.max(MAX_OFFICES)
		.refine((ids) => new Set(ids).size === ids.length, 'IDs doppelt')
});
export type OfficeOrderInput = z.infer<typeof officeOrderInput>;

export const holderInput = z.object({
	userId: z.string().min(1).max(100),
	since: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'Format JJJJ-MM-TT')
		.refine(isRealDate, 'Kein gültiges Datum')
		.nullish()
		.transform((v) => v ?? null)
});

/** Inhaber*innen komplett ersetzen; Reihenfolge der Liste = Anzeige-Reihenfolge */
export const holdersInput = z.object({
	holders: z
		.array(holderInput)
		.max(MAX_HOLDERS, `Höchstens ${MAX_HOLDERS} Personen`)
		.superRefine((list, ctx) => {
			const seen = new Set<string>();
			list.forEach((h, i) => {
				if (seen.has(h.userId)) {
					ctx.addIssue({ code: 'custom', path: [i, 'userId'], message: 'Person doppelt' });
				}
				seen.add(h.userId);
			});
		})
});
export type HoldersInput = z.input<typeof holdersInput>;

export const bioInput = z.object({ bio: optionalText(MAX_BIO) });
export type BioInput = z.input<typeof bioInput>;

/** PUT `/me/website` – Zustimmung zur Anzeige auf der Stammeswebsite (Opt-in) */
export const websiteOptInInput = z.object({ showOnWebsite: z.boolean() }).strict();
export type WebsiteOptInInput = z.input<typeof websiteOptInInput>;

export const userSearchQuery = z.object({ search: z.string().trim().max(100).default('') });

// ---------------------------------------------------------------------------
// DTOs (Antworten)
// ---------------------------------------------------------------------------

export interface OfficeEmail {
	id: string;
	label: string | null;
	email: string;
}

export interface OfficeRoleRef {
	id: string;
	/** `Unbekannte Rolle`, wenn die Rolle im Core gelöscht wurde */
	name: string;
}

export interface OfficeHolder {
	userId: string;
	/** Anzeigename; `Unbekannt` bei gelöschten/deaktivierten Konten */
	name: string;
	/** Profilbild-URL (`/avatar/<id>?v=…`) oder `null` */
	image: string | null;
	since: string | null;
	/** Persönliche Beschreibung (eine je Person, für alle Ämter gleich) */
	bio: string | null;
}

/** Herkunft eines Amts aus einer Modul-Vorlage (`manifest.offices`) */
export interface OfficeSource {
	module: string;
	/** Anzeigename des Moduls, z. B. „Kasse“ */
	moduleName: string;
	key: string;
}

/** Benachrichtigung eines Vorlagen-Amts (nur Anzeige) */
export interface OfficeNotificationInfo {
	key: string;
	label: string;
	description: string | null;
}

export interface Office {
	id: string;
	name: string;
	description: string | null;
	position: number;
	emails: OfficeEmail[];
	roles: OfficeRoleRef[];
	holders: OfficeHolder[];
	/** `null` bei selbst angelegten Ämtern */
	source: OfficeSource | null;
	/** Benachrichtigungen aus der Vorlage (leer ohne Vorlage oder wenn das Modul inaktiv ist) */
	notifications: OfficeNotificationInfo[];
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Benachrichtigungen (Profil)
// ---------------------------------------------------------------------------

export const NOTIFY_MODES = ['immediate', 'daily', 'off'] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];
export const DEFAULT_NOTIFY_MODE: NotifyMode = 'immediate';
export const NOTIFY_MODE_LABELS: Record<NotifyMode, string> = {
	immediate: 'Sofort',
	daily: 'Täglich (Zusammenfassung)',
	off: 'Aus'
};

const keyPattern = z
	.string()
	.min(1)
	.max(60)
	.regex(/^[a-z][a-z0-9-]*$/, 'Ungültiger Schlüssel');

/** `PUT /me/notifications`: Modus für ein Ereignis eines eigenen Vorlagen-Amts */
export const notificationPrefInput = z.object({
	module: keyPattern,
	office: keyPattern,
	event: keyPattern,
	mode: z.enum(NOTIFY_MODES)
});
export type NotificationPrefInput = z.infer<typeof notificationPrefInput>;

/** `GET /me/notifications` (und Antwort von `PUT`) */
export interface MyNotifications {
	/** Konto-Adresse, an die Benachrichtigungen gehen */
	email: string | null;
	offices: {
		officeId: string;
		officeName: string;
		module: string;
		moduleName: string;
		officeKey: string;
		events: (OfficeNotificationInfo & { mode: NotifyMode })[];
	}[];
}

/** `GET /me`: eigene Ämter und Beschreibung */
export interface MyOffices {
	offices: { id: string; name: string }[];
	bio: string | null;
	/** Nur wer mindestens ein Amt hat, darf eine Beschreibung speichern */
	canEditBio: boolean;
	/** Zustimmung: Name, Profilbild und Beschreibung erscheinen auf der Stammeswebsite (Standard aus) */
	showOnWebsite: boolean;
}

export interface UserRef {
	id: string;
	name: string;
	email: string;
}

export interface RoleRef {
	id: string;
	name: string;
}

// Website-API (API-Key mit Scope `offices.website.read`): nur öffentliche Felder

export interface WebsiteOfficeHolder {
	/** Stabile ID für Avatar-Abruf (`/website/offices/holders/:userId/avatar`) */
	id: string;
	name: string;
	bio: string | null;
	since: string | null;
	/** Relativer API-Pfad des Profilbilds oder `null` ohne Bild */
	avatarPath: string | null;
}

export interface WebsiteOffice {
	id: string;
	name: string;
	description: string | null;
	position: number;
	emails: { label: string | null; email: string }[];
	holders: WebsiteOfficeHolder[];
}
